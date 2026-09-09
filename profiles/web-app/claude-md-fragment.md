## Repo-specific constraints

1. **Nothing secret reaches the client bundle.** Anything referenced in client-side code is public. Server-only values live in host environment configuration, mirrored by name into `.env.example` and `.dev.vars.example`.
2. **The build is the gate.** `npm run build` must pass before every push; a green dev server proves nothing about the deployed output. Content and layout ship together — a copy change that breaks the layout is a broken change.
3. **Design tokens are the source of styling truth.** New colors, spacing values, or font sizes go into the token layer, never inline into a component. `/design-review` checks this.
4. **Accessibility is a conformance target, not a preference.** WCAG 2.2 Level AA — see the accessibility section of `repo-standards.md` in the `daftplate` repo. `/design-review` does not check it for you.
