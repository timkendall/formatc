#!/bin/zsh
# Builds /tmp/cb/corpus.bin (~41 MB): the first 4000 files of /tmp/vscode-files.txt concatenated (paths with spaces are skipped by xargs).
mkdir -p /tmp/cb
cd /Users/timkendall/Developer/lab/scriptc-formatter/bench/vscode && head -4000 /tmp/vscode-files.txt | xargs cat > /tmp/cb/corpus.bin 2>/dev/null
ls -l /tmp/cb/corpus.bin
