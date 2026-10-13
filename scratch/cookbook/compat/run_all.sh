#!/bin/zsh
# for each snippet: node output vs compiled output
cd "$(dirname $0)"
mkdir -p bin
printf "%-32s %-8s %s\n" SNIPPET RESULT DETAIL
for f in *.ts; do
  n=${f%.ts}
  exp=$(node --experimental-transform-types --no-warnings $f 2>&1)
  cout=$(scriptc build $f -o bin/$n 2>&1)
  if [ $? -ne 0 ]; then
    code=$(echo "$cout" | grep -o 'SC[0-9]*' | sort -u | tr '\n' ',' )
    msg=$(echo "$cout" | grep -m1 -E 'error SC' | sed 's/.*error //' | cut -c1-110)
    printf "%-32s %-8s %s\n" $n COMPILE_FAIL "$msg"
  else
    act=$(./bin/$n 2>&1)
    if [ "$exp" = "$act" ]; then printf "%-32s %-8s\n" $n PASS; else printf "%-32s %-8s node=[%s] sc=[%s]\n" $n DIFF "$(echo $exp | head -c 80)" "$(echo $act | head -c 80)"; fi
  fi
done
