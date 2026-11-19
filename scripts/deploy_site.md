# Deploying the website (`site/`)

The site is plain static files: no build step, no framework, no server code. Anything that serves a folder works. Two routes are described here.

Before deploying a release, the Step 4 release script puts the ZIP in `site/downloads/` and fills in the version, size and SHA-256 on `index.html`. Then run the checks in release mode, which fails if the ZIP is missing:

```
python scripts/test_site.py --strict
```

Note: `*.zip` is in `.gitignore`, so the ZIP is **not** in git. Route (a) with the CLI uploads your local folder (ZIP included). Routes that deploy from git (Vercel's GitHub integration, GitHub Pages) need the ZIP to get there another way; the Step 4 release script decides how (for example a GitHub Release asset, or a force-added file on the deploy branch).

## (a) Vercel

`site/vercel.json` sets `"cleanUrls": true`, so `/privacy.html` is served as `/privacy` (the `.html` URLs redirect there; links in the pages keep working either way).

### Option 1: from your PC with the CLI

Needs Node.js 18+.

```
cd site
npx vercel login          # first time only
npx vercel --prod
```

The first run asks a few questions: pick your account, create a new project (for example `sidm`), and accept `./` as the directory. There is no build command and no output directory to set; leave them empty / default. It prints the production URL when done. Later deploys are just `npx vercel --prod` from `site/`.

### Option 2: connect the GitHub repo

1. On vercel.com, **Add New > Project**, and import `ShamimHosen75/GetSmart-DM`.
2. **Root Directory**: click Edit and choose `site`.
3. **Framework Preset**: Other. Build command and output directory: leave empty.
4. Deploy. Every push to `main` then deploys production; other branches get preview URLs.

## (b) GitHub Pages

GitHub Pages serves a branch. Put the contents of `site/` at the root of a `gh-pages` branch:

```
git subtree push --prefix site origin gh-pages
```

Then on GitHub: **Settings > Pages > Build and deployment > Source: Deploy from a branch**, branch `gh-pages`, folder `/ (root)`. The site appears at `https://<user>.github.io/GetSmart-DM/` within a minute or two.

If `subtree push` is rejected because `gh-pages` has diverged, force-update it:

```
git push origin `git subtree split --prefix site HEAD`:gh-pages --force
```

Notes for Pages:

- `vercel.json` is ignored there, and `cleanUrls` does not apply; the `.html` links still work, and Pages also serves `/privacy` for `privacy.html`.
- All links in the site are relative, so the `/GetSmart-DM/` sub-path works without changes.
- Add an empty `.nojekyll` file at the branch root if you ever add files or folders starting with `_`.

## Custom domain

Buy the domain from any registrar, then:

### On Vercel

1. Project **Settings > Domains > Add**, enter `yourdomain.com` (your domain) and also `www.yourdomain.com`. Vercel suggests redirecting one to the other; accept.
2. At your registrar's DNS settings, add what Vercel shows. Normally:
   - apex `@`: **A** record to `76.76.21.21`
   - `www`: **CNAME** to `cname.vercel-dns.com`
   (Or switch the domain's nameservers to Vercel's and let it manage DNS.)
3. HTTPS certificates are issued automatically once DNS resolves (minutes, up to a day for DNS to spread).

### On GitHub Pages

1. **Settings > Pages > Custom domain**: enter `www.yourdomain.com` and save. This commits a `CNAME` file to `gh-pages`; if you redeploy with the force-push command above, add a `site/CNAME` file containing the domain so it survives.
2. At your registrar:
   - `www`: **CNAME** to `<user>.github.io`
   - apex `@`: **A** records to `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` (and AAAA `2606:50c0:8000::153` to `2606:50c0:8003::153` for IPv6)
3. When the DNS check passes, tick **Enforce HTTPS**.

Check the current values in the Vercel or GitHub docs before you add records; they rarely change, but the dashboards always show the right ones for your project.

## After deploying

- Open the site on a phone and a desktop, light and dark mode.
- Click **Download for Windows** and check the ZIP downloads and its size and SHA-256 match the page.
- Check `/privacy` and `/terms` load.
