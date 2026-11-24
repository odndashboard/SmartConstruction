# CRM performance

## November 24, 2026 update

The successful initial page load verifies the current user once and starts the existing workspace and operations database reads in parallel. The authenticated page supplies both results to the client. This removes the two sequential browser data requests that previously followed the page and JavaScript downloads.

The initial operations snapshot is consumed once. Revisiting Dashboard, pressing Refresh, or returning after the existing focus interval still requests live records. User identity, active membership and permissions are verified before data is serialized. An operations outage shows unavailable summaries and a retry option; an access denial fails the entire bootstrap.

The page proxy renews sessions with `getClaims()`. Fresh `getUser()` verification and the database's member checks still decide access to private records. No user, role or business data is cached across requests.

## Smaller initial download

Settings, Team Activity and operations interfaces use dynamic imports. Larger operations sections load separately. Navigation intent preloads the relevant code, and selecting an operations module loads its section code while its data request is in progress. Sign-out has a small standalone component, so the Dashboard does not download all account forms just to display that button.

The following comparison uses production build manifests and gzip level 9 for the same framework and route files. It counts each initial JavaScript file once and excludes deferred chunks and the legacy-browser polyfill. It measures JavaScript size, not a device's page-load time or actual CDN compression.

| Initial route JavaScript | Previous build | Optimized build | Difference |
| --- | ---: | ---: | ---: |
| Dashboard, raw | 909,897 bytes | 586,376 bytes | 35.6% smaller |
| Dashboard, gzip estimate | 256,011 bytes | 171,006 bytes | 33.2% smaller |
| Login, gzip estimate | 141,400 bytes | 142,281 bytes | 0.6% larger |

The small login increase accompanies the shared loading boundary. The main Dashboard download saves approximately 85 KB compressed. Assets retain hashed URLs and ordinary browser caching; the Android wrapper already uses the default WebView cache policy. This release needs no new APK.

Reproduce the current build measurement:

```sh
npm run build
node scripts/measure-client-bundle.mjs / /login
```

## Less rendering work

Lead search uses an indexed customer lookup and a memoized result. Search rendering is deferred so typing remains responsive. India date and INR currency formatting reuse fixed, immutable locale formatters; formatted values and private records are not cached. Existing paise arithmetic, Indian grouping, timezone and financial-year boundaries remain unchanged.

## Slow connections and validation

Client GET reads retain the 15-second deadline across headers and JSON bodies. The initial server workspace RPC has a ten-second budget, and optional operations have five seconds. These server budgets begin after authentication and do not guarantee a total page-load time. Writes and mutation replay behavior are unchanged.

The release passed 178 automated tests, TypeScript, targeted ESLint and the production build. Tests cover parallel bootstrap reads, independent callers, immediate authorization failures, mixed roles, optional outages, cancellation, deadlines and formatting equivalence. Real-device speed still depends on connection quality, hosting startup and record volume.
