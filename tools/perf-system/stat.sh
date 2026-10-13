#!/bin/sh
# One run with resource counters: tools/perf-system/stat.sh <binary> [args...]   (run in bench/vscode; FMT_TRACE=1 adds the phases)
f=$(mktemp)
/usr/bin/time -l "$@" >/dev/null 2>"$f"
grep -E "^(scan|expand|workers|walk done)|^ +[0-9.]+ real|instructions retired|cycles elapsed|maximum resident|page reclaims|involuntary|^ +[0-9]+ +(voluntary)" "$f"
rm -f "$f"
