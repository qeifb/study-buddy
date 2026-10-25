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


def _build_model(model_path, device, compute_type, cpu_threads=0, num_workers=1):
    """构建模型。

    cpu_threads：CPU 转写时用几个线程。0 = 让 ctranslate2 自己决定。
                 转码速度档位就是通过它控制 CPU 占用率的（实测：12 逻辑核下
                 threads=2→25%, 4→40%, 6→55%, 12→94%）。
    num_workers：并行 worker 数（进程内多实例）。
    """
    from faster_whisper import WhisperModel

    kw = {
        "device": device,
        "compute_type": compute_type,
        "download_root": os.environ.get("STUDY_WHISPER_CACHE") or None,
    }
    if cpu_threads and cpu_threads > 0:
        kw["cpu_threads"] = cpu_threads
    if num_workers and num_workers > 1:
        kw["num_workers"] = num_workers
    return WhisperModel(model_path, **kw)

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


# ══════════════════════════════════════════════════════════════
# 转码速度控制 + CPU/GPU 并行（2026-10-25 新增）
#
# 用户需求原话：
#   「智能识别当前设备的cpu使用率，最高仅占用当前可用的的cpu使用率的80%
#    （注意是只算空闲的cpu，比如现在cpu正在使用20%，那按80%来算最高仅占用64%）
#    转码尽量占满，做三个选项：性能优先/平衡模式/静音模式」
#
# 实测数据（12 逻辑核，60s 中文语音）：
#   threads=2  → CPU 25%,  27.0s
#   threads=4  → CPU 40%,  18.9s
#   threads=6  → CPU 55%,  16.2s
#   threads=12 → CPU 94%,  14.7s
# ══════════════════════════════════════════════════════════════

SPEED_PROFILES = {
    "performance": 0.80,   # 性能优先：占用空闲 CPU 的 80%
    "balanced": 0.60,      # 平衡模式：60%（默认）
    "quiet": 0.40,         # 静音模式：40%
}


def _cpu_busy_percent(sample_ms=200):
    """读当前系统 CPU 占用率（0-100）。Windows 用 GetSystemTimes。"""
    try:
        import ctypes
        from ctypes import wintypes

        class FT(ctypes.Structure):
            _fields_ = [("lo", wintypes.DWORD), ("hi", wintypes.DWORD)]

        def iv(ft):
            return (ft.hi << 32) | ft.lo

        def read():
            i, k, u = FT(), FT(), FT()
            ctypes.windll.kernel32.GetSystemTimes(
                ctypes.byref(i), ctypes.byref(k), ctypes.byref(u)
            )
            return iv(i), iv(k), iv(u)

        i0, k0, u0 = read()
        time.sleep(sample_ms / 1000.0)
        i1, k1, u1 = read()
        idle = i1 - i0
        total = (k1 - k0) + (u1 - u0)
        if total <= 0:
            return 0.0
        return max(0.0, min(100.0, (total - idle) / total * 100.0))
    except Exception:
        return 0.0


def _pick_cpu_threads(speed, logical_cpus):
    """按「空闲占用比例」反算该用几个线程。

    设当前系统占用 U（0-100），空闲 = 100-U，
    目标总占用 T = U + (100-U) * ratio。
    再按实测映射：threads ≈ logical * T / 100（实测偏高约 8%，取保守）。
    """
    ratio = SPEED_PROFILES.get(speed, 0.60)
    busy = _cpu_busy_percent()
    target_total = busy + (100.0 - busy) * ratio
    # 保守：减去 8 个百分点，抵消实测偏高
    target_total = max(10.0, target_total - 8.0)
    threads = int(round(logical_cpus * target_total / 100.0))
    threads = max(1, min(logical_cpus, threads))
    log(
        "转码速度=%s（空闲占%d%%）｜当前CPU占用%.0f%% → 目标总占用%.0f%% → 使用 %d/%d 线程"
        % (speed, ratio * 100, busy, target_total, threads, logical_cpus)
    )
    return threads


def _find_nvidia_dll(dll_name):
    """在 site-packages/nvidia 下找某个 DLL，找到就 CDLL 加载它。"""
    import ctypes
    import os as _os

    # ① 先试系统路径
    try:
        ctypes.CDLL(dll_name)
        return True
    except OSError:
        pass

    # ② 再试 nvidia 包目录
    base = _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))
    nvdir = _os.path.join(base, "pyenv", "Lib", "site-packages", "nvidia")
    if not _os.path.isdir(nvdir):
        return False
    for root, _dirs, files in _os.walk(nvdir):
        if dll_name not in files:
            continue
        try:
            ctypes.CDLL(_os.path.join(root, dll_name))
            return True
        except OSError:
            continue
    return False


def _gpu_ready():
    """GPU 是否真的可用：不只看驱动，还要 cublas / cudnn 能加载。"""
    try:
        import ctranslate2

        n = ctranslate2.get_cuda_device_count()
    except Exception as exc:
        return False, "ctranslate2 不可用：%s" % exc
    if n <= 0:
        return False, "没有检测到 NVIDIA CUDA 设备（A 卡/集显不支持）"

    missing = []
    for dll in ("cublas64_12.dll", "cudnn64_9.dll"):
        if not _find_nvidia_dll(dll):
            missing.append(dll)
    if missing:
        return False, "缺少 %s（需在设置里点「下载 GPU 组件」）" % "、".join(missing)
    return True, ""


def _split_audio(media, out_a, out_b):
    """把音频按时间切成两半（供 CPU/GPU 并行）。返回 (dur_a, dur_b) 或 None。"""
    try:
        import av
    except Exception:
        return None
    try:
        inp = av.open(media)
        s0 = inp.streams.audio[0]
        total = float(inp.duration) / av.time_base if inp.duration else 0.0
        inp.close()
        if total <= 1.0:
            return None
        mid = total / 2.0

        def write(dst, t0, t1):
            src = av.open(media)
            s = src.streams.audio[0]
            rate = float(s.rate or 16000)
            out = av.open(dst, mode="w")
            ost = out.add_stream("aac", rate=16000)
            ost.layout = "mono"
            for fr in src.decode(s):
                if fr.pts is None:
                    continue
                tt = float(fr.pts) / rate
                if tt < t0 or tt >= t1:
                    continue
                fr.pts = None
                for pkt in ost.encode(fr):
                    out.mux(pkt)
            for pkt in ost.encode(None):
                out.mux(pkt)
            out.close()
            src.close()

        write(out_a, 0, mid)
        write(out_b, mid, total + 1)
        return (mid, total - mid)
    except Exception as exc:
        log("切分音频失败（退回单路转写）：%s" % exc)
        return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("media")
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default=os.environ.get("STUDY_WHISPER_MODEL", "large-v3-turbo"))
    ap.add_argument("--model-dir", default=os.environ.get("STUDY_WHISPER_MODEL_DIR") or None)
    ap.add_argument("--language", default="zh")
    ap.add_argument("--device", default=os.environ.get("STUDY_WHISPER_DEVICE", "auto"))
    ap.add_argument("--speed", default=os.environ.get("STUDY_WHISPER_SPEED", "balanced"),
                    help="转码速度: performance=占用空闲CPU的80%%, balanced=60%%, quiet=40%%")
    ap.add_argument("--parallel", default=os.environ.get("STUDY_WHISPER_PARALLEL", "0"),
                    help="1 = CPU+GPU 一起转（需要 NVIDIA 卡且已装 GPU 组件）")
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
    # ── 转码速度：先算出该用多少 CPU 线程（2026-10-25 新增）──
    logical = os.cpu_count() or 4
    speed = (args.speed or "balanced").strip().lower()
    if speed not in SPEED_PROFILES:
        speed = "balanced"
    cpu_threads = _pick_cpu_threads(speed, logical)

    # ── CPU+GPU 并行：只有显式开启且 GPU 真可用才做 ──
    want_parallel = str(args.parallel or "0").strip() in ("1", "true", "True", "yes")
    parallel_ok = False
    parallel_why = ""
    if want_parallel:
        parallel_ok, parallel_why = _gpu_ready()
        if parallel_ok:
            log("已开启 CPU+GPU 并行转码（把音频切两半，CPU 与 GPU 各转一半）")
        else:
            log("CPU+GPU 并行不可用：%s → 退回单路转写" % parallel_why)

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
            # CPU 设备才用 cpu_threads 控占用；GPU 设备不需要
            th = cpu_threads if device == "cpu" else 0
            model = _build_model(model_path, device, compute, cpu_threads=th)
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

    # ── CPU+GPU 并行转码（2026-10-25 新增）──
    # 思路：把音频按时间切两半，CPU 转前半、GPU 转后半，两个线程同时跑，最后合并。
    # 前提：GPU 真可用（cublas/cudnn 都能加载），否则退回单路。
    if parallel_ok and used and used[0] == "cuda":
        import tempfile as _tf
        import threading as _th

        tmp_a = os.path.join(_tf.gettempdir(), "sb-par-a-%d.mp4" % os.getpid())
        tmp_b = os.path.join(_tf.gettempdir(), "sb-par-b-%d.mp4" % os.getpid())
        halves = _split_audio(args.media, tmp_a, tmp_b)
        if halves:
            log("已把音频切成两半（%.0fs / %.0fs），准备 CPU+GPU 并行" % halves)
            par_result = {"ok": False, "err": "", "items": []}

            def _worker_cpu():
                try:
                    m = _build_model(model_path, "cpu", "int8", cpu_threads=cpu_threads)
                    segs, _info = _run(m, tmp_a, args.language, args.beam_size,
                                       args.hotwords, args.initial_prompt, log_every=20)
                    par_result["items"].append(("cpu", segs, 0.0))
                    log("并行-CPU 完成：%d 段" % len(segs))
                except Exception as exc:  # noqa: BLE001
                    par_result["err"] += "CPU:%s; " % exc

            def _worker_gpu():
                try:
                    m = _build_model(model_path, "cuda", "float16")
                    segs, _info = _run(m, tmp_b, args.language, args.beam_size,
                                       args.hotwords, args.initial_prompt, log_every=100)
                    par_result["items"].append(("cuda", segs, halves[0]))
                    log("并行-GPU 完成：%d 段" % len(segs))
                except Exception as exc:  # noqa: BLE001
                    par_result["err"] += "GPU:%s; " % exc

            t_cpu = _th.Thread(target=_worker_cpu)
            t_gpu = _th.Thread(target=_worker_gpu)
            t_cpu.start()
            t_gpu.start()
            t_cpu.join()
            t_gpu.join()

            try:
                os.remove(tmp_a)
            except Exception:
                pass
            try:
                os.remove(tmp_b)
            except Exception:
                pass

            if len(par_result["items"]) == 2:
                merged = []
                for _dev, segs, offset in par_result["items"]:
                    for s in segs:
                        merged.append({
                            "start": round(float(s.get("start", 0)) + offset, 2),
                            "end": round(float(s.get("end", 0)) + offset, 2),
                            "text": s.get("text", ""),
                        })
                merged.sort(key=lambda x: x["start"])
                used = ("cpu+cuda", "int8+float16")
                log("CPU+GPU 并行完成，合并后共 %d 段" % len(merged))
                elapsed = time.time() - t0
                json.dump(
                    {
                        "ok": True,
                        "language": args.language,
                        "duration": round(float(segments[0].get("end", 0)) if merged else 0.0, 1),
                        "device": used[0],
                        "compute_type": used[1],
                        "elapsed": round(elapsed, 1),
                        "segments": merged,
                    },
                    open(args.out, "w", encoding="utf-8"),
                    ensure_ascii=False,
                )
                log("完成：%d 段，用时 %.1fs（device=%s 并行）" % (len(merged), elapsed, used[0]))
                return 0
            else:
                log("并行失败（%s），退回单路转写" % par_result["err"].strip())

    # ── 单路转写（原有逻辑）──
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
                model = _build_model(model_path, "cpu", "int8", cpu_threads=cpu_threads)
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
