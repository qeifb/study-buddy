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
def _run(model, media, language, beam_size, hotwords=None, initial_prompt=None,
         log_every=20, channel=""):
    """转写并流式上报进度。

    ★ 2026-10-26：新增 channel 参数（''/'CPU '/'GPU '）。
      原来 CPU、GPU 两个线程共用同一个 log 前缀，两条进度流交替出现，
      界面上只能看到一条线来回跳 —— 用户反馈「GPU 的进度一显示就被 CPU 顶下去」。
      现在每条流带自己的通道标识，进度互不覆盖。
    """
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
            if channel:
                log(f"{channel}｜{len(out)} 段 · {seg.end:.0f}s")
            else:
                log(f"转写中｜{len(out)} 段 · {seg.end:.0f}s")
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
        "加速档位｜%s（空闲占%d%%）｜当前CPU占用%.0f%% → 目标总占用%.0f%% → 使用 %d/%d 线程"
        % (speed, ratio * 100, busy, target_total, threads, logical_cpus)
    )
    return threads


def _find_nvidia_dll(dll_name):
    # 2026-10-25 fix: 路径不能从 __file__ 推断。
    #   transcribe.py 在 <root>/tools/ 下，nvidia 在 <root>/tools/pyenv/Lib/site-packages/nvidia。
    #   dirname(dirname(__file__)) 会得到 <root>，再拼 pyenv 就错了。
    #   这里从 transcribe.py 所在目录出发。
    import ctypes
    import os as _os

    # 1) 先试系统路径（CUDA Toolkit 装在系统里时能直接命中）
    try:
        ctypes.CDLL(dll_name)
        return True
    except OSError:
        pass

    # 2) 再试 nvidia 包目录（多个候选，兼容 pyenv 在不同层级的情况）
    here = _os.path.dirname(_os.path.abspath(__file__))
    candidates = [
        _os.path.join(here, "pyenv", "Lib", "site-packages", "nvidia"),
        _os.path.join(_os.path.dirname(here), "pyenv", "Lib", "site-packages", "nvidia"),
        _os.path.join(here, "..", "pyenv", "Lib", "site-packages", "nvidia"),
    ]
    for nvdir in candidates:
        nvdir = _os.path.abspath(nvdir)
        if not _os.path.isdir(nvdir):
            continue
        for root, _dirs, files in _os.walk(nvdir):
            if dll_name not in files:
                continue
            # 关键：先把所在目录加入 DLL 搜索路径，否则 cublasLt 等依赖找不到
            handles = []
            try:
                if hasattr(_os, "add_dll_directory"):
                    handles.append(_os.add_dll_directory(root))
                ctypes.CDLL(_os.path.join(root, dll_name))
                return True
            except OSError:
                continue
            finally:
                for h in handles:
                    try:
                        _os.remove_dll_directory(h)
                    except Exception:
                        pass
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


# ══════════════════════════════════════════════════════════════
# 智能 CPU/GPU 负载分配（2026-10-26 新增）
#
# 用户要求：「自动对比CPU与GPU性能，哪边强就把转码任务多往哪边靠」
#
# 本机实测（40s 中文语音，2026-10-26）：
#   CPU 最快 21.13s（8~12 线程）
#   GPU 最快  2.15s（float16）  → GPU 快 9.83 倍
#
# 分配原理：
#   设 CPU 速度为 c（秒墙钟 / 音频秒），GPU 速度为 g。
#   两路耗时相等时总时间最短：c*x = g*(1-x)  →  x = g/(c+g)
#   所以 CPU 分 x，GPU 分 1-x。
#   例：c=0.52, g=0.053 → x = 0.053/0.573 ≈ 9%（CPU 9%，GPU 91%）
#
# 但纯理论会出问题，加三条保护：
#   ① 安全边界 [0.15, 0.85] —— 避免一侧分得太少，模型加载开销反占大头
#   ② 基准测试结果缓存，避免每次转码都测（测试要花 10~20 秒）
#   ③ 缓存带失效条件（模型名 / CPU 核数变化）
# ══════════════════════════════════════════════════════════════

BENCH_CACHE_NAME = ".speed-bench.json"


def _bench_cache_path(model_path):
    """基准缓存放在模型目录**里面**（跟着模型走）。

    ★ 2026-10-26：原来用 dirname(model_path)，当 model_path 是目录时会跑到上一级
      （实测跑到 tools/models/ 而不是 tools/models/large-v3-turbo/）。
      现在：是目录就放进去，是文件就放同级。
    """
    try:
        p = os.path.abspath(model_path)
        d = p if os.path.isdir(p) else os.path.dirname(p)
    except Exception:
        d = os.getcwd()
    return os.path.join(d, BENCH_CACHE_NAME)


def _load_bench_cache(model_path):
    """读缓存；模型名 / CPU 核数任一变化就作废。"""
    p = _bench_cache_path(model_path)
    try:
        if not os.path.exists(p):
            return None
        c = json.load(open(p, encoding="utf-8"))
        if c.get("model") != os.path.basename(model_path):
            return None
        if int(c.get("cpus", 0)) != int(os.cpu_count() or 0):
            return None
        if float(c.get("cpu_speed", 0)) <= 0 or float(c.get("gpu_speed", 0)) <= 0:
            return None
        return c
    except Exception:
        return None


def _save_bench_cache(model_path, data):
    try:
        p = _bench_cache_path(model_path)
        with open(p, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=1)
    except Exception:
        pass


def _make_bench_audio(seconds=12):
    """造基准测试音频。纯正弦波会被 VAD 过滤，输出极少 —— 正好只要「跑完的耗时」。"""
    import tempfile as _tf
    try:
        import av
        import numpy as _np
    except Exception as exc:
        log("基准音频生成失败（缺 av/numpy）｜%s" % exc)
        return None

    p = os.path.join(_tf.gettempdir(), "sb-bench-%d.mp4" % os.getpid())
    try:
        out = av.open(p, mode="w")
        st = out.add_stream("aac", rate=16000)
        st.layout = "mono"
        sr = 16000
        total = sr * seconds
        for i in range(0, total, 1024):
            n = min(1024, total - i)
            tt = _np.arange(i, i + n) / sr
            sig = _np.sin(2 * _np.pi * 440 * tt) * 4000
            arr = sig.astype("int16").reshape(1, -1)
            fr = av.AudioFrame.from_ndarray(arr, format="s16", layout="mono")
            fr.sample_rate = sr
            fr.pts = i
            for pkt in st.encode(fr):
                out.mux(pkt)
        for pkt in st.encode(None):
            out.mux(pkt)
        out.close()
        return p
    except Exception as exc:
        log("基准音频写入失败｜%s" % exc)
        try:
            os.remove(p)
        except Exception:
            pass
        return None


def _bench_one(model_path, device, compute, cpu_threads, audio_path):
    """测某设备的**纯转写吞吐**，返回「秒 / 音频秒」。

    ★ 2026-10-26 关键修正：必须拆开「模型加载」与「转写」两段计时。
      旧的写法把加载（2~3 秒）算进去了，而加载是固定开销、与音频长度无关，
      在短音频上会严重稀释 GPU 优势 —— 实测真实差距 9.83 倍，
      旧基准只测出 1.8 倍，导致智能分配算错比例。
    """
    try:
        import av
        inp = av.open(audio_path)
        dur = float(inp.duration) / av.time_base if inp.duration else 0.0
        inp.close()
        if dur <= 0:
            dur = 1.0
    except Exception:
        dur = 1.0

    try:
        kw = {}
        if device == "cpu" and cpu_threads and cpu_threads > 0:
            kw["cpu_threads"] = cpu_threads

        # ① 单独计加载时间（不计入速度）
        t_load0 = time.time()
        m = _build_model(model_path, device, compute, **kw)
        load_el = time.time() - t_load0

        # ② 只计纯转写
        # ★ 2026-10-26 关键：基准必须 vad_filter=False！
        #   实测正弦波 30s：VAD 开会把它当静音全丢掉，只花 0.22s（CPU）/0.08s（GPU），
        #   测出的 "GPU 快 2.8 倍" 完全是假的；关掉 VAD 后是 6.14s/0.57s = 快 10.8 倍，
        #   与真实语音的 11.3 倍基本一致。
        t0 = time.time()
        segs, _info = m.transcribe(audio_path, language="zh", vad_filter=False)
        list(segs)
        infer_el = time.time() - t0
        del m

        log("  基准 %s/%s｜加载 %.1fs(不计) · 转写 %.2fs / %.0fs 音频"
            % (device, compute, load_el, infer_el, dur))
        return infer_el / dur
    except Exception as exc:
        log("性能基准｜%s/%s 失败｜%s" % (device, compute, exc))
        return None


def _smart_split_ratio(model_path, cpu_threads, force=False):
    """算出 CPU:GPU 任务切分比例。返回 (cpu_ratio, gpu_ratio, meta)。"""
    ok, why = _gpu_ready()
    if not ok:
        log("硬件加速｜不可用（%s）→ 单路 CPU" % why)
        return (1.0, 0.0, {"gpu": False, "reason": why})

    cached = None if force else _load_bench_cache(model_path)
    if cached:
        c = float(cached["cpu_speed"])
        g = float(cached["gpu_speed"])
        log("性能基准｜缓存 CPU %.3f · GPU %.3f s/音频s（GPU ×%.1f）"
            % (c, g, (c / g) if g > 0 else 0))
    else:
        log("性能基准｜首测（约 10~30s，结果会缓存）")
        # 20 秒：关 VAD 后 CPU 约 4 秒、GPU 约 0.4 秒，足够测准且不拖慢首次运行
        bench = _make_bench_audio(20)
        if not bench:
            log("性能基准｜不可用 → 均分 50/50")
            return (0.5, 0.5, {"gpu": True, "reason": "no-bench-audio"})
        try:
            c = _bench_one(model_path, "cpu", "int8", cpu_threads, bench)
            g = _bench_one(model_path, "cuda", "float16", 0, bench)
        finally:
            try:
                os.remove(bench)
            except Exception:
                pass
        if not c or not g or c <= 0 or g <= 0:
            log("性能基准｜失败 → 均分 50/50")
            return (0.5, 0.5, {"gpu": True, "reason": "bench-failed"})
        log("性能基准｜CPU %.3f · GPU %.3f s/音频s（GPU ×%.1f）" % (c, g, c / g))
        _save_bench_cache(model_path, {
            "model": os.path.basename(model_path),
            "cpus": os.cpu_count() or 0,
            "ts": int(time.time()),
            "cpu_speed": c,
            "gpu_speed": g,
        })

    total = c + g
    cpu_ratio = g / total          # 快的多分
    gpu_ratio = c / total
    # 安全边界：避免一侧分太少。
    # ★ 2026-10-26 由 0.15 下调到 0.05，依据实测：
    #   279s 音频，CPU 分 15%（42s）耗时 19.5s，GPU 分 85%（237s）只耗时 11.5s，
    #   CPU 成了瓶颈、总时间被拖住 8 秒。按实测速度反算理想点约 9.5%，
    #   但下限 15% 强行多分给它 → 反而更慢。
    #   0.05 仍能保证 CPU 至少处理 5%（避免固定开销占大头）。
    cpu_ratio = max(0.05, min(0.85, cpu_ratio))
    gpu_ratio = 1.0 - cpu_ratio

    log("负载分配｜CPU %.0f%% · GPU %.0f%%（按实测吞吐反比）"
        % (cpu_ratio * 100, gpu_ratio * 100))
    return (cpu_ratio, gpu_ratio, {"cpu_speed": c, "gpu_speed": g, "gpu": True})


def _split_audio(media, out_a, out_b, ratio=0.5):
    """把音频按 ratio 切成两段（供 CPU/GPU 并行）。

    ratio = 前半段占比（CPU 那侧）。默认 0.5（均分）。
    智能分配会传实测比例，例如 GPU 快 10 倍时 ratio≈0.15。
    返回 (dur_a, dur_b) 或 None。
    """
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
        # ratio 是前半段（CPU）占比；限制在合理区间，避免切出空片段
        r = max(0.05, min(0.95, float(ratio or 0.5)))
        mid = total * r

        def write(dst, t0, t1):
            """把 [t0, t1) 区间的音频写成新文件。

            ★ 2026-10-26 修复 errno 22：
              旧写法把 fr.pts 设为 None（清空时间戳），mux 时报 "Invalid argument"。
              正确做法：保留 pts，只把时间轴平移到从 0 开始。
            """
            src = av.open(media)
            s = src.streams.audio[0]
            rate = float(s.rate or 16000)
            out = av.open(dst, mode="w")
            ost = out.add_stream("aac", rate=16000)
            ost.layout = "mono"
            base = None
            for fr in src.decode(s):
                if fr.pts is None:
                    continue
                tt = float(fr.pts) / rate
                if tt < t0 or tt >= t1:
                    continue
                if base is None:
                    base = int(fr.pts)
                # 保留 pts，但平移到从 0 开始（绝不能清空）
                fr.pts = int(fr.pts) - base
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
        log("音频切分失败 → 回落单路｜%s" % exc)
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
            log("硬件加速｜请求启用")
        else:
            log("硬件加速｜不可用（%s）→ 回落单路转写" % parallel_why)

    attempts = []
    want = (args.device or "auto").strip().lower()

    if want == "cpu":
        attempts = [("cpu", "int8")]
        log("加速模式｜仅 CPU（用户设定）")
    elif want == "cuda":
        # 用户明确要 GPU：不做静默降级。
        # ★ 2026-10-27：先查 cublas/cudnn 组件在不在。
        #   之前不查就直接 _build_model("cuda", ...)，ctranslate2 抛的底层错误
        #   是「Library cublas64_12.dll is not found」，用户看不懂、也不知道去哪修。
        #   现在组件缺失时给一句能操作的话，并记进结果 JSON。
        ready_ok, ready_why = _gpu_ready()
        if not ready_ok:
            log("加速模式｜仅 GPU（用户设定，不自动回落）")
            log("硬件加速｜不可用（%s）" % ready_why)
            json.dump(
                {"ok": False, "error": "GPU 组件不完整：%s（设置页点「下载 GPU 组件」，约 1.8GB）" % ready_why},
                open(args.out, "w", encoding="utf-8"),
                ensure_ascii=False,
            )
            return 2
        # ★ 注意：compute_type='auto' 不能直接传给 ctranslate2（它只认
        #   float16/int8_float16/int8/float32 等具体值），要展开成候选序列。
        if args.compute_type == "auto":
            attempts = [("cuda", "float16"), ("cuda", "int8_float16"), ("cuda", "int8")]
        else:
            attempts = [("cuda", args.compute_type)]
        log("加速模式｜仅 GPU（用户设定，不自动回落）")
    else:
        # auto：探测 GPU 是否真的存在，再决定尝试顺序
        has_gpu = False
        try:
            import ctranslate2
            has_gpu = ctranslate2.get_cuda_device_count() > 0
        except Exception:
            has_gpu = False
        if has_gpu:
            # ★ 2026-10-27：显卡在 ≠ 组件齐。cublas/cudnn 缺失时直接走 CPU，
            #   并说清原因——免得先试 GPU 再报一串底层 DLL 错误、最后才退 CPU。
            gpu_ok, gpu_why = _gpu_ready()
            if gpu_ok:
                log("加速模式｜自动（NVIDIA 已就绪，失败回落 CPU）")
                if args.compute_type == "auto":
                    # 先试 float16（最快且省显存），不行再试 int8_float16，最后 CPU
                    attempts = [("cuda", "float16"), ("cuda", "int8_float16"), ("cpu", "int8")]
                else:
                    attempts = [("cuda", args.compute_type), ("cpu", "int8")]
            else:
                log("加速模式｜仅 CPU（%s）" % gpu_why)
                attempts = [("cpu", "int8")]
        else:
            log("加速模式｜仅 CPU（无可用 NVIDIA GPU；A 卡/集显无 CUDA 后端）")
            attempts = [("cpu", "int8")]

    model = None
    used = None
    last_err = None
    for device, compute in attempts:
        log(f"加载模型｜{device}/{compute}")
        try:
            # CPU 设备才用 cpu_threads 控占用；GPU 设备不需要
            th = cpu_threads if device == "cpu" else 0
            model = _build_model(model_path, device, compute, cpu_threads=th)
            used = (device, compute)
            log(f"模型就绪｜{device}/{compute}")
            break
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            log(f"模型加载失败｜{device}/{compute}｜{exc}")

    if model is None:
        # ★ 2026-10-27：用户截图里的三类加载失败（bad allocation / mkl_malloc /
        #   CUDA out of memory / busy or unavailable）都走到这里，统一给可操作提示。
        hint = ""
        low = str(last_err).lower()
        if "out of memory" in low or "bad allocation" in low or "mkl_malloc" in low or "failed to allocate" in low:
            hint = "（内存/显存不够：关掉占用显存和内存的程序重试；若选了「仅 GPU」可改成「自动」让它退回 CPU）"
        elif "busy or unavailable" in low:
            hint = "（显卡正被别的程序占用：关掉它们重试，或把加速模式改成「自动」）"
        elif "cublas" in low or "cudnn" in low or "not found" in low:
            hint = "（GPU 组件不完整：设置页点「下载 GPU 组件」，或把加速模式改成「自动」）"
        json.dump({"ok": False, "error": f"模型加载失败: {last_err}{hint}"}, open(args.out, "w", encoding="utf-8"))
        return 2

    log("转写启动")

    # ── CPU+GPU 并行转码（2026-10-25 新增）──
    # 思路：把音频按时间切两半，CPU 转前半、GPU 转后半，两个线程同时跑，最后合并。
    # 前提：GPU 真可用（cublas/cudnn 都能加载），否则退回单路。
    if parallel_ok and used and used[0] == "cuda":
        import tempfile as _tf
        import threading as _th

        tmp_a = os.path.join(_tf.gettempdir(), "sb-par-a-%d.mp4" % os.getpid())
        tmp_b = os.path.join(_tf.gettempdir(), "sb-par-b-%d.mp4" % os.getpid())
        # ★ 2026-10-26：按实测 CPU/GPU 性能智能切分，不再固定 50/50
        cpu_ratio, gpu_ratio, split_meta = _smart_split_ratio(model_path, cpu_threads)
        halves = _split_audio(args.media, tmp_a, tmp_b, ratio=cpu_ratio)
        if halves:
            log("硬件加速｜已启动 · 切分 %.0fs / %.0fs" % halves)
            par_result = {"ok": False, "err": "", "items": []}
            # 两路共用同一个起始时刻，便于对比各自耗时
            _ch_t0 = [time.time()]

            def _worker_cpu():
                try:
                    m = _build_model(model_path, "cpu", "int8", cpu_threads=cpu_threads)
                    segs, _info = _run(m, tmp_a, args.language, args.beam_size,
                                       args.hotwords, args.initial_prompt,
                                       log_every=3, channel="CPU ")
                    par_result["items"].append(("cpu", segs, 0.0))
                    log("CPU 通道完成｜%d 段 · %.1fs" % (len(segs), time.time() - _ch_t0[0]))
                except Exception as exc:  # noqa: BLE001
                    par_result["err"] += "CPU:%s; " % exc

            def _worker_gpu():
                try:
                    m = _build_model(model_path, "cuda", "float16")
                    segs, _info = _run(m, tmp_b, args.language, args.beam_size,
                                       args.hotwords, args.initial_prompt,
                                       log_every=3, channel="GPU ")
                    par_result["items"].append(("cuda", segs, halves[0]))
                    log("GPU 通道完成｜%d 段 · %.1fs" % (len(segs), time.time() - _ch_t0[0]))
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
                log("硬件加速｜合并完成 · 共 %d 段" % len(merged))
                elapsed = time.time() - t0
                json.dump(
                    {
                        "ok": True,
                        "language": args.language,
                        # 2026-10-25 fix: 这里原来引用了不存在的 segments 变量
                        #   （并行分支里只有 merged，segments 是单路分支的变量）
                        #   导致 NameError，整个并行结果写不出来
                        "duration": round(float(merged[-1].get("end", 0)) if merged else 0.0, 1),
                        "device": used[0],
                        "compute_type": used[1],
                        "elapsed": round(elapsed, 1),
                        "split": {"cpu_ratio": round(cpu_ratio, 3), "gpu_ratio": round(gpu_ratio, 3),
                                  "bench": split_meta},
                        "segments": merged,
                    },
                    open(args.out, "w", encoding="utf-8"),
                    ensure_ascii=False,
                )
                log("转写完成｜%d 段 · %.1fs · %s 硬件加速" % (len(merged), elapsed, used[0]))
                return 0
            else:
                log("硬件加速｜失败（%s）→ 回落单路" % par_result["err"].strip())

    # ── 单路转写（原有逻辑）──
    try:
        try:
            out, info = _run(model, args.media, args.language, args.beam_size, args.hotwords, args.initial_prompt)
        except Exception as exc:  # noqa: BLE001
            msg = str(exc)
            gpu_like = any(k in msg.lower() for k in ("cublas", "cudnn", "cuda", "no kernel image", "gpu", "out of memory", "bad allocation", "mkl_malloc", "busy or unavailable"))
            # ★ 2026-10-25：用户设置 cpu 或显式 cuda 时不静默降级；
            #   auto 模式下任何 GPU 类失败都退回 CPU，保证「万无一失」。
            can_fallback = (want == "auto") and (used[0] != "cpu") and gpu_like
            if can_fallback:
                log(f"GPU 失败（{msg}）→ 回落 CPU int8 重试")
                model = _build_model(model_path, "cpu", "int8", cpu_threads=cpu_threads)
                used = ("cpu", "int8")
                out, info = _run(model, args.media, args.language, args.beam_size, args.hotwords, args.initial_prompt)
            else:
                raise
    except Exception as exc:  # noqa: BLE001
        # ★ 2026-10-27：把「显卡忙 / 显存不够」这两类用户最常见的情况
        #   翻译成人话。ctranslate2 的原文分别是
        #     "CUDA failed with error out of memory"
        #     "CUDA-capable device(s) is/are busy or unavailable"
        #   报给用户前先给一句能操作的。
        msg = str(exc)
        hint = ""
        low = msg.lower()
        if "out of memory" in low:
            hint = "（显卡显存不够：关闭占用显存的程序，或在设置里把加速模式改成「自动」让它退回 CPU）"
        elif "busy or unavailable" in low:
            hint = "（显卡正被别的程序占用：关掉它们重试，或把加速模式改成「自动」）"
        json.dump({"ok": False, "error": f"转写失败: {exc}{hint}"}, open(args.out, "w", encoding="utf-8"))
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
    log(f"转写完成｜{len(out)} 段 · {result['elapsed']}s · {used[0]}/{used[1]}")
    return 0


if __name__ == "__main__":
    _patch_av_compat()
    _patch_nvidia_dlls()
    sys.exit(main())
