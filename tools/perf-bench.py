"""
三模式性能基准测试（2026-10-26 用户需求）

用户原话：
  「以后打开应用开始转码前先出现一个弹窗，提示开始转码前先做一次性能测试，
   看3种模式哪种合适，并把测试结果展示出来和模式选择框展示出来
   并推荐用户选择哪种模式，比如你刚刚做的那个测试，结果是GPU最强，
   就在弹出页面上提示用户可以选择纯GPU模式，
   但仅仅只做推荐，用户想选择其他模式还是可以自行选择自己想要的模式，
   记住我们只做推荐不需要写不推荐的备注说明」

测试三种模式：仅 CPU / 仅 GPU / CPU+GPU 并行
输出 JSON：{ ok, dur, modes: [{ id, label, wall, rtf, segs, ok, err }], recommend, gainVsSecond }

用法：python _perf_bench.py <音频路径> [--out json路径]
"""
import os
import sys
import json
import time
import subprocess
import argparse


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("media")
    ap.add_argument("--out", required=True)
    ap.add_argument("--model-dir", default="")
    ap.add_argument("--speed", default="balanced")
    ap.add_argument("--timeout", type=int, default=900)
    args = ap.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    tp = os.path.join(here, "transcribe.py")
    py = sys.executable

    model_dir = args.model_dir or os.environ.get("STUDY_WHISPER_MODEL") or "large-v3-turbo"

    # 音频时长
    dur = 0.0
    try:
        import av
        with av.open(args.media) as c:
            if c.duration:
                dur = float(c.duration) / av.time_base
    except Exception:
        pass

    MODES = [
        ("cpu", "仅 CPU", ["--device", "cpu", "--speed", args.speed]),
        ("gpu", "仅 GPU", ["--device", "cuda", "--speed", args.speed]),
        ("parallel", "CPU+GPU 并行", ["--device", "auto", "--parallel", "1", "--speed", args.speed]),
    ]

    results = []
    for mid, label, extra in MODES:
        out_json = os.path.join(os.environ.get("TEMP", "."), "sb-perf-%s-%d.json" % (mid, os.getpid()))
        try:
            if os.path.exists(out_json):
                os.remove(out_json)
        except Exception:
            pass
        cmd = [py, tp, args.media, "--out", out_json, "--model-dir", model_dir] + extra
        t0 = time.time()
        err_tail = ""
        segs = 0
        ok = False
        try:
            p = subprocess.run(cmd, capture_output=True, text=True,
                               encoding="utf-8", errors="replace",
                               timeout=args.timeout)
            wall = time.time() - t0
            if p.returncode == 0 and os.path.exists(out_json):
                try:
                    with open(out_json, encoding="utf-8") as fh:
                        j = json.load(fh)
                    ok = bool(j.get("ok"))
                    segs = len(j.get("segments") or [])
                except Exception as exc:
                    err_tail = str(exc)[:120]
            else:
                err_tail = (p.stderr or "")[-300:]
        except subprocess.TimeoutExpired:
            wall = time.time() - t0
            err_tail = "超时"
        except Exception as exc:
            wall = time.time() - t0
            err_tail = str(exc)[:150]
        finally:
            try:
                if os.path.exists(out_json):
                    os.remove(out_json)
            except Exception:
                pass

        results.append({
            "id": mid,
            "label": label,
            "wall": round(wall, 1),
            "rtf": round(wall / dur, 4) if dur > 0 else 0,
            "segs": segs,
            "ok": ok,
            "err": ("失败" if not ok else "") if not err_tail else err_tail.strip()[:160],
        })

    # ── 推荐逻辑：按实测去掉失败项，取最快 ──
    good = [r for r in results if r["ok"]]
    recommend = ""
    gain = 0.0
    if good:
        fast = min(good, key=lambda r: r["wall"])
        recommend = fast["id"]
        # 相对第二快省多少
        others = [r for r in good if r["id"] != fast["id"]]
        seconds = sorted([r["wall"] for r in others])
        gain = round(seconds[0] - fast["wall"], 1) if seconds else 0.0

    out = {
        "ok": bool(good),
        "dur": round(dur, 1),
        "modes": results,
        "recommend": recommend,
        "gainVsSecond": gain,
        # 2026-10-26：测试音频是纯正弦波，会被 VAD 判为静音，segs 通常为 0。
        # 这不影响计时（跑完整条编码路径），但界面不要据此判断"失败"。
        "note": "测试音频为合成音，转出 0 段属正常；本测试只关心耗时。",
    }
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
