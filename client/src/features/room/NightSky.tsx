/** A few compound paths keep the little city detailed without a node per window. */
export function NightSky() {
  return (
    <svg className="night-sky" viewBox="0 0 320 180" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="night-haze" x2="0" y2="1">
          <stop stopColor="#18243e" /><stop offset=".58" stopColor="#353a5c" /><stop offset="1" stopColor="#78617c" />
        </linearGradient>
        <radialGradient id="moon-halo"><stop stopColor="#f2dab6" stopOpacity=".17" /><stop offset="1" stopColor="#f2dab6" stopOpacity="0" /></radialGradient>
      </defs>
      <path fill="url(#night-haze)" d="M0 0h320v180H0z" />
      <circle cx="262" cy="39" r="40" fill="url(#moon-halo)" />
      <path transform="translate(12 0)" fill="#f3ddb3" d="M258 24a16 16 0 1 0 6 26 17 17 0 0 1-6-26Z" />
      <path fill="#c0b9d9" opacity=".65" d="M22 19h2v2h-2z M67 55h2v2h-2z M100 17h2v2h-2z M137 45h2v2h-2z M171 21h2v2h-2z M204 64h2v2h-2z M288 63h2v2h-2z M306 20h2v2h-2z M38 79h2v2h-2z M153 82h2v2h-2z" />
      <path className="sky-twinkle" fill="#f3d8b7" d="M82 29h2v3h3v2h-3v3h-2v-3h-3v-2h3z M219 13h2v2h2v2h-2v2h-2v-2h-2v-2h2z M283 86h2v2h2v2h-2v2h-2v-2h-2v-2h2z" />
      <path fill="#51506d" d="M0 111h18V91h16v18h17V78h21v26h18V91h23V69h18v38h16V86h23v16h18V76h23v26h14V87h26v24h17V80h18v17h18V91h17v89H0Z" />
      <path fill="#393c58" d="M0 139h27v-33h20v14h16v-22h23v29h18v-25h24v23h25V91h22v35h24v-19h21v26h21V98h23v30h24v-21h17v73H0Z" />
      <path fill="#242c43" d="M0 146h13v-25h23v59h9v-42h23v42h10v-63h25v63h12v-36h26v36h12v-64h28v64h9v-34h28v34h12v-56h26v56h13v-43h24v43h9v-58h20v58H0Z" />
      <path stroke="#30334c" strokeWidth="2" d="M89 117V106m77 10V99m76 25v-13m69 11v-11" />
      <path fill="#e8bc82" opacity=".8" d="M19 129h3v5h-3z M29 145h3v5h-3z M51 146h3v5h-3z M61 161h3v5h-3z M85 127h3v5h-3z M95 141h3v5h-3z M85 157h3v5h-3z M123 153h3v5h-3z M133 166h3v5h-3z M161 126h3v5h-3z M171 141h3v5h-3z M161 158h3v5h-3z M198 155h3v5h-3z M208 168h3v5h-3z M238 134h3v5h-3z M248 150h3v5h-3z M238 166h3v5h-3z M277 147h3v5h-3z M307 132h3v5h-3z M307 159h3v5h-3z" />
      <path fill="#b2a6c8" opacity=".35" d="M55 87h2v3h-2z M120 78h2v3h-2z M196 85h2v3h-2z M275 90h2v3h-2z M157 99h2v3h-2z M72 107h2v3h-2z" />
    </svg>
  );
}
