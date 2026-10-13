"""Token use and estimated cost of a Claude Code session and its sub-agents, from the local transcripts.

    python3 -I tools/agent-cost.py <session-id> [agent-id ...]

Prints one line per transcript: model family, API calls, cache reads, cache writes (5-minute / 1-hour TTL), uncached input,
output, and the cost at list API prices. With agent ids, only those sub-agents (and the session itself) are listed.

Output tokens: sub-agent transcripts record only the first streaming count of each response (5-20 tokens), so `out-est` is
the visible text and tool inputs they wrote at ~3.5 characters per token. Hidden thinking is not in the transcript; allow up
to ~4x that for it. The session's own transcript records real output counts.
"""
import glob
import json
import os
import sys

PROJECT = os.path.expanduser("~/.claude/projects/-Users-timkendall-Developer-lab-scriptc-formatter/")
# $ per million tokens: input, output, cache read. Cache writes are 1.25x (5 min) or 2x (1 h) the input price.
PRICE = {"opus": (4.0, 20.0, 0.20), "sonnet": (2.0, 10.0, 0.20), "haiku": (0.10, 0.50, 0.01)}
HAIKU_LONG = (0.50, 2.50, 0.05)  # Haiku 5.5 prompts over 100K tokens


def family(model):
    return next((k for k in PRICE if k in (model or "")), None)


def summarize(path):
    usage, visible = {}, {}
    for line in open(path):
        try:
            e = json.loads(line)
        except ValueError:
            continue
        m = e.get("message") or {}
        if e.get("type") != "assistant":
            continue
        if m.get("usage"):
            usage[m.get("id")] = (m.get("model"), m["usage"])
        for b in m.get("content") or []:
            if isinstance(b, dict):
                s = b.get("text") or b.get("thinking") or (json.dumps(b.get("input")) if b.get("type") == "tool_use" else "")
                visible[(m.get("id"), b.get("id") or (s or "")[:50])] = len(s or "")
    t = dict(fam=set(), calls=0, read=0, w5=0, w1=0, unc=0, out=0, cost=0.0)
    out_price = 0.0
    for model, u in usage.values():
        f = family(model)
        if not f:
            continue
        t["fam"].add(f)
        cc = u.get("cache_creation") or {}
        w5, w1 = cc.get("ephemeral_5m_input_tokens", 0) or 0, cc.get("ephemeral_1h_input_tokens", 0) or 0
        w5 += max(0, (u.get("cache_creation_input_tokens", 0) or 0) - w5 - w1)
        r, un, o = u.get("cache_read_input_tokens", 0) or 0, u.get("input_tokens", 0) or 0, u.get("output_tokens", 0) or 0
        pi, po, pr = PRICE[f]
        if f == "haiku" and r + w5 + w1 + un > 100_000:
            pi, po, pr = HAIKU_LONG
        t["cost"] += (un * pi + r * pr + w5 * pi * 1.25 + w1 * pi * 2 + o * po) / 1e6
        out_price = po
        t["calls"] += 1
        t["read"] += r
        t["w5"] += w5
        t["w1"] += w1
        t["unc"] += un
        t["out"] += o
    t["out_est"] = max(t["out"], sum(visible.values()) / 3.5)
    t["cost"] += (t["out_est"] - t["out"]) * out_price / 1e6
    return t


def main():
    session, agents = sys.argv[1], sys.argv[2:]
    rows = [("session", summarize(PROJECT + session + ".jsonl"))]
    for f in sorted(glob.glob(PROJECT + session + "/subagents/agent-*.jsonl")):
        name = os.path.basename(f)[len("agent-"):-len(".jsonl")]
        if not agents or name in agents:
            rows.append((name, summarize(f)))
    tot = dict(calls=0, read=0, w5=0, w1=0, unc=0, out_est=0, cost=0.0)
    for name, t in rows:
        print(f"{name:18s} {','.join(sorted(t['fam'])):7s} calls {t['calls']:5d}  read {t['read']/1e6:8.2f}M  "
              f"write {t['w5']/1e6:6.2f}M + {t['w1']/1e6:5.2f}M  uncached {t['unc']:7d}  out-est {t['out_est']/1e6:6.3f}M  ${t['cost']:.2f}")
        for k in tot:
            tot[k] += t[k]
    print(f"{'total':26s} calls {tot['calls']:5d}  read {tot['read']/1e6:8.2f}M  write {tot['w5']/1e6:6.2f}M + "
          f"{tot['w1']/1e6:5.2f}M  uncached {tot['unc']:7d}  out-est {tot['out_est']/1e6:6.3f}M  ${tot['cost']:.2f}")


if __name__ == "__main__":
    main()
