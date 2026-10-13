#!/bin/zsh
cd "$(dirname $0)/multi"
mkdir -p ../bin
for f in cyc_a cyc_class_a reexp_main modstate_main tla_order_main; do
  exp=$(node --experimental-transform-types --no-warnings $f.ts 2>&1 | head -5)
  cout=$(scriptc build $f.ts -o ../bin/m_$f 2>&1)
  if [ $? -ne 0 ]; then printf "%-24s COMPILE_FAIL %s\n" $f "$(echo "$cout" | grep -m1 'error SC' | cut -c1-150)"; else
    act=$(../bin/m_$f 2>&1 | head -5); [ "$exp" = "$act" ] && printf "%-24s PASS\n" $f || printf "%-24s DIFF node=[%s] sc=[%s]\n" $f "$exp" "$act"; fi
done
