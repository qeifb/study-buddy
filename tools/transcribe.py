#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""用 faster-whisper 把任意音视频文件转写成带时间戳的分段文本。

用法:
    python transcribe.py <media> --out result.json [--model-dir <本地CT2目录>] [--language zh]

输出 JSON:
    { "ok": true, "language": "zh", "duration": 950.0, "device": "cuda",
      "segments": [{"start": 0.0, "end": 4.2, "text": "..."}], "text": "全文" }

模型来源：插件用 ModelScope 预先下到 %LOCALAPPDATA%\\dsh-study-companion\\models\\
（这台机器 huggingface.co 被 hosts 屏蔽、hf-mirror 也不稳定，所以不用 HF）

GPU：装了 nvidia-cublas-cu12 / nvidia-cudnn-cu12 时会自动把这些 DLL 目录加进搜索路径；
如果 GPU 加载或推理失败，自动退回 CPU int8，不会让整次转写失败。
"""
import argparse
import json
import os
import sys
import time


def _patch_av_compat():
    """PyAV 19 移除了 av.open(metadata_errors=...)，而 faster-whisper 1.2.1 仍在传。

    faster_whisper/audio.py:46 是 `av.open(input_file, mode="r", metadata_errors="ignore")`，
    新版 PyAV 直接抛 TypeError: open() got an unexpected keyword argument 'metadata_errors'。
    这里做一个透明垫片：先按原参数调用，只有遇到这个 TypeError 才去掉该参数重试。
    """
    try:
        import av
    except Exception:  # noqa: BLE001
        return
    original = av.open
    if getattr(original, "_chaoxing_compat", False):
        return

    def compat_open(*args, **kwargs):
        try:
            return original(*args, **kwargs)
        except TypeError as exc:
            if "metadata_errors" in str(exc) and "metadata_errors" in kwargs:
                kwargs.pop("metadata_errors")
                return original(*args, **kwargs)
            raise

    compat_open._chaoxing_compat = True
    compat_open.__doc__ = getattr(original, "__doc__", None)
    av.open = compat_open


_DLL_HANDLES = []


def _patch_nvidia_dlls():
    """把 pip 装的 nvidia-*-cu12 的 bin 目录加进 DLL 搜索路径（Windows 上必需）。"""
    if os.name != "nt":
        return
    roots = []
    try:
        import site
        for sp in list(site.getsitepackages()) + [site.getusersitepackages()]:
            roots.append(os.path.join(sp, "nvidia"))
    except Exception:  # noqa: BLE001
        pass
    roots.append(os.path.join(os.path.dirname(os.path.dirname(sys.executable)),
                              "Lib", "site-packages", "nvidia"))
    for root in roots:
        if not os.path.isdir(root):
            continue
        for name in os.listdir(root):
            bin_dir = os.path.join(root, name, "bin")
            if not os.path.isdir(bin_dir):
                continue
            try:
                _DLL_HANDLES.append(os.add_dll_directory(bin_dir))
            except Exception:  # noqa: BLE001
                pass
            os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")


def log(msg):
    print(f"[transcribe] {msg}", file=sys.stderr, flush=True)


def _build_model(model_path, device, compute_type):
    from faster_whisper import WhisperModel
    return WhisperModel(
        model_path,
        device=device,
        compute_type=compute_type,
        download_root=os.environ.get("STUDY_WHISPER_CACHE") or None,
    )


# log_every：每转写多少段报一次进度。
# 2026-10-25 由 100 改为 20 —— 用户要求「应用端恢复以往设置，20 段展示一次进度」：
#   间隔太小（每段）界面数字一直跳、看着吵；
#   间隔太大（100+）会让用户以为卡住了。20 段约等于 1 分钟音频，节奏刚好。
def _run(model, media, language, beam_size, hotwords=None, initial_prompt=None, log_every=20):
    kwargs = {
        "language": language or None,
        "beam_size": beam_size,
        "vad_filter": True,
        "vad_parameters": {"min_silence_duration_ms": 500},
    }
    if hotwords:
        kwargs["hotwords"] = hotwords
    if initial_prompt:
        kwargs["initial_prompt"] = initial_prompt
    segments, info = model.transcribe(media, **kwargs)
    out = []
    for seg in segments:
        text = (seg.text or "").strip()
        if not text:
            continue
        out.append({"start": round(seg.start, 2), "end": round(seg.end, 2), "text": text})
        if len(out) % log_every == 0:
            log(f"已转写 {len(out)} 段 / 到 {seg.end:.0f}s")
    return out, info


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("media")
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default=os.environ.get("STUDY_WHISPER_MODEL", "large-v3-turbo"))
    ap.add_argument("--model-dir", default=os.environ.get("STUDY_WHISPER_MODEL_DIR") or None)
    ap.add_argument("--language", default="zh")
    ap.add_argument("--device", default=os.environ.get("STUDY_WHISPER_DEVICE", "auto"))
    ap.add_argument("--compute-type", default=os.environ.get("STUDY_WHISPER_COMPUTE", "auto"))
    ap.add_argument("--beam-size", type=int, default=5)
    ap.add_argument("--hotwords", default=os.environ.get("STUDY_WHISPER_HOTWORDS", ""))
    ap.add_argument("--initial-prompt", default=os.environ.get("STUDY_WHISPER_PROMPT", ""))
    args = ap.parse_args()

    t0 = time.time()
    try:
        from faster_whisper import WhisperModel  # noqa: F401
    except Exception as exc:  # noqa: BLE001
        json.dump({"ok": False, "error": f"faster_whisper 未安装: {exc}"}, open(args.out, "w", encoding="utf-8"))
        return 1

    model_path = args.model_dir or args.model
    # ══════════════════════════════════════════════════════════════
    # 设备选择策略（2026-10-25 重写，用户要求「万无一失的 GPU 加速」）
    #
    # --device 支持三档：
    #   auto  → 先试 GPU，任何环节失败都自动退 CPU（默认，照顾大众）
    #   cuda  → 只用 GPU。用户明确要求 GPU 时，若 GPU 不可用则**报错而不是静默降级**
    #           （避免「我明明选了 GPU，结果偷偷用 CPU 跑了 10 分钟」）
    #   cpu   → 只用 CPU（照顾特殊用户：集显笔记本、GPU 被占用、远程桌面等）
    #
    # 注意：ctranslate2 只支持 NVIDIA CUDA，**AMD 显卡 / Intel 集显会自动走 CPU**
    #       （get_cuda_device_count() 返回 0 时直接跳 CPU，不做无意义的 GPU 尝试）
    # ══════════════════════════════════════════════════════════════
    attempts = []
    want = (args.device or "auto").strip().lower()

    if want == "cpu":
        attempts = [("cpu", "int8")]
        log("已选择：仅 CPU（用户设置）")
    elif want == "cuda":
        # 用户明确要 GPU：不做静默降级。
        # ★ 注意：compute_type='auto' 不能直接传给 ctranslate2（它只认
        #   float16/int8_float16/int8/float32 等具体值），要展开成候选序列。
        if args.compute_type == "auto":
            attempts = [("cuda", "float16"), ("cuda", "int8_float16"), ("cuda", "int8")]
        else:
            attempts = [("cuda", args.compute_type)]
        log("已选择：仅 GPU（用户设置，不会自动退回 CPU）")
    else:
        # auto：探测 GPU 是否真的存在，再决定尝试顺序
        has_gpu = False
        try:
            import ctranslate2
            has_gpu = ctranslate2.get_cuda_device_count() > 0
        except Exception:
            has_gpu = False
        if has_gpu:
            log("检测到 NVIDIA GPU，优先尝试 GPU 加速（失败会自动退回 CPU）")
            if args.compute_type == "auto":
                # 先试 float16（最快且省显存），不行再试 int8_float16，最后 CPU
                attempts = [("cuda", "float16"), ("cuda", "int8_float16"), ("cpu", "int8")]
            else:
                attempts = [("cuda", args.compute_type), ("cpu", "int8")]
        else:
            log("未检测到可用 NVIDIA GPU（AMD/Intel 显卡不支持 CUDA 加速），使用 CPU")
            attempts = [("cpu", "int8")]

    model = None
    used = None
    last_err = None
    for device, compute in attempts:
        log(f"加载模型 {model_path} (device={device}, compute={compute})")
        try:
            model = _build_model(model_path, device, compute)
            used = (device, compute)
            log(f"模型加载成功：device={device}, compute_type={compute}")
            break
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            log(f"device={device} compute={compute} 加载失败：{exc}")

    if model is None:
        json.dump({"ok": False, "error": f"模型加载失败: {last_err}"}, open(args.out, "w", encoding="utf-8"))
        return 2

    log("开始转写…")
    try:
        try:
            out, info = _run(model, args.media, args.language, args.beam_size, args.hotwords, args.initial_prompt)
        except Exception as exc:  # noqa: BLE001
            msg = str(exc)
            gpu_like = any(k in msg.lower() for k in ("cublas", "cudnn", "cuda", "no kernel image", "gpu", "out of memory"))
            # ★ 2026-10-25：用户设置 cpu 或显式 cuda 时不静默降级；
            #   auto 模式下任何 GPU 类失败都退回 CPU，保证「万无一失」。
            can_fallback = (want == "auto") and (used[0] != "cpu") and gpu_like
            if can_fallback:
                log(f"GPU 转写失败（{msg}），自动退回 CPU int8 重试（不影响结果，只是慢一些）")
                model = _build_model(model_path, "cpu", "int8")
                used = ("cpu", "int8")
                out, info = _run(model, args.media, args.language, args.beam_size, args.hotwords, args.initial_prompt)
            else:
                raise
    except Exception as exc:  # noqa: BLE001
        json.dump({"ok": False, "error": f"转写失败: {exc}"}, open(args.out, "w", encoding="utf-8"))
        return 3

    result = {
        "ok": True,
        "language": getattr(info, "language", None),
        "device": used[0],
        "compute_type": used[1],
        "duration": round(getattr(info, "duration", 0.0) or 0.0, 2),
        "elapsed": round(time.time() - t0, 1),
        "segments": out,
        "text": "".join(s["text"] for s in out),
    }
    with open(args.out, "w", encoding="utf-8") as fp:
        json.dump(result, fp, ensure_ascii=False)
    log(f"完成：{len(out)} 段，用时 {result['elapsed']}s（实际使用设备={used[0]}/{used[1]}）")
    return 0


if __name__ == "__main__":
    _patch_av_compat()
    _patch_nvidia_dlls()
    sys.exit(main())
