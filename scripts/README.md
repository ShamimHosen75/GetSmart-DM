# scripts/

Packaging and release scripts (extension ZIP, companion bundle, site assets).

Status: placeholder. Built in Step 4. See the root `CLAUDE.md` for rules.

## Website

- `test_site.py`: QA for `site/` (popup screenshots, renders at 1280/390 px, link check, download link, HTML validation). Needs `pip install playwright pillow` and `python -m playwright install chromium`; `html5validator` optional.
- `deploy_site.md`: how to deploy `site/` to Vercel or GitHub Pages and point a custom domain.
