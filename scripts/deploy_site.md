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

## Recommended for sidm.online: Cloudflare Pages + GitHub Releases

The domain is **sidm.online**. Cloudflare's free plan has no bandwidth cap, which matters for the 1M-visitor goal. Pages refuses files of 25 MiB or more, so the Android APKs (about 60 MB each) are not in `site/`: they are attached to the GitHub Release `v<version>` (https://github.com/ShamimHosen75/GetSmart-DM/releases), and the site's Android buttons link there. `site/_redirects` also sends the old `/downloads/<apk>` addresses there, for the Android app's in-app updater. The extension ZIP, setup .exe and companion ZIPs are small and stay in `site/downloads/`. `python scripts/check_site_size.py` (also run by the test workflow) fails if anything in `site/` reaches 25 MiB.

1. **Move DNS to Cloudflare.** Sign up at cloudflare.com (Free plan), **Add a domain** `sidm.online`. Cloudflare shows two nameservers. At the registrar, turn DNSSEC off if it is on, then replace the domain's nameservers with those two. Wait for Cloudflare's "active" email (minutes, up to a day).
2. **Site.** **Workers & Pages > Create > Pages > Connect to Git**, pick `GetSmart-DM`, production branch `main`, framework preset **None**, build command empty, **build output directory `site`**. Deploy.
3. **Domain on the site.** In the Pages project, **Custom domains > Set up a domain**: `sidm.online`, then again for `www.sidm.online`. Cloudflare adds the DNS records itself (CNAME `sidm.online` and CNAME `www`, both to `<project>.pages.dev`, proxied). Each page's canonical tag points at `https://sidm.online/...`, so search engines treat www as the same site.
4. **Downloads.** Nothing to set up. The small downloads deploy with the site; the APKs are uploaded to the GitHub Release by the android workflow's "publish" run (see `mobile/android/README.md`).
5. **Search.** Add `sidm.online` in Google Search Console (Domain property; the TXT record can be added from Cloudflare DNS), then submit `https://sidm.online/sitemap.xml`.

`scripts/build_sitemap.py` writes the sitemap, robots.txt and each page's canonical / Open Graph tags for `https://sidm.online` by default; run it again after adding a page.

## Custom domain (other hosts)

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
