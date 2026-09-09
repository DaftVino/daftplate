# Profile: web-app

## When to use

A public-facing site or marketing app built with a static/hybrid framework and deployed to an edge host. Exemplar: an Astro marketing site on Cloudflare Pages.

## Stack assumptions

- Astro (or an equivalent static-first framework) with a `src/` tree and a build step.
- Cloudflare Pages for hosting; environment configuration through the host, never committed.
- Design work is first-class: the gstack design family is part of the pipeline, not an afterthought.

## Metadata

```profile
verify: npm run build
test: npm test
deploy: /land-and-deploy
docs-subdirs: designs, adr
roadmap: required
```

## Extra directories

`src/`, `public/`, `docs/deploy-guide.md`. `assets/` for source media that is not shipped as-is.

## Overrides

None. This profile only adds files; `files-override/` is absent.
