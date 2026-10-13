// All JSX forms.
const a1 = <div />;
const a2 = <div></div>;
const a3 = <div>text</div>;
const a4 = <div a="1" b='2' c={3} d {...e} f={<g />} />;
const a5 = <></>;
const a6 = <>text<b /></>;
const a7 = <A.B.C />;
const a8 = <this.x />;
const a9 = <ns:tag ns:attr="v" />;
const a10 = <a-b data-x="1" aria-label="l" />;
const a11 = <div>{x}{/* comment */}{}</div>;
const a12 = <div>{...children}</div>;
const a13 = <div>
  text &amp; &lt; &#123; &#x7B; &nbsp; &copy;
  <span>nested</span>
  {cond ? <a /> : <b />}
  {list.map(i => <li key={i}>{i}</li>)}
</div>;
const a14 = <Generic<string> prop="x" />;
const a15 = <A<B<C>> />;
const a16 = <div className="a" {...props} key="k" ref={r}></div>;
const a17 = <div>{"string"}</div>;
const a18 = <div attr={`template ${x}`} />;
const a19 = cond && <div />;
const a20 = <div>   </div>;
const a21 = <div>

</div>;
const a22 = <input disabled value="x" onChange={(e) => set(e.target.value)} />;
const a23 = <Foo render={() => <div />} />;
const a24 = <div a="&quot;x&quot;" b='it&apos;s' />;
const a25 = <div>{`a`}{'b'}{"c"}</div>;
const a26 = (
  <div>
    <A />
    <B />
  </div>
);
function C() { return <div>hi</div>; }
const D = () => <><A /><B /></>;
const e1 = <T,>(x: T) => x;
const e2 = <T extends unknown>(x: T) => x;
const f1 = <div>{/* c */}</div>;
const f2 = <a href="x">link</a>;
const f4 = <div>a{" "}b</div>;
const f5 = <div>{a}{b}</div>;
const f6 = <A b={<C />} />;
const f7 = <div>&</div>;
const g1 = <A.B.C.D prop />;
const g2 = <div style={{ color: "red" }} />;
