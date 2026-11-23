# Smart Construction for Android

This native Android application opens the existing Smart Construction cloud CRM at `https://smart-construction-dashboard.vercel.app`. Employees use their own CRM email and password; they do not need provider or ChatGPT accounts. Company data, Owner permissions, employee removal and password recovery remain controlled by the existing server.

## Application

- Application ID: `com.smartconstruction.crm`
- Version: `1.1.0` / version code `2`
- Minimum Android: 8.0, API 26
- Compile and target SDK: 36
- Build tools: 36.0.0
- Java: 17
- Android Gradle Plugin: 8.13.2
- Gradle wrapper: 8.13 with a pinned distribution checksum
- AndroidX WebKit: 1.14.0; native web messaging is enabled only when the installed Android System WebView supports it

The launcher icon and splash use a navy/gold construction mark. A compact native header offers Refresh workspace and Open in browser. Use a quotation's Print action for Android printing or Save PDF. Android Back first lets the CRM close a dialog/drawer or return to its dashboard, then uses WebView history or closes the Activity. System-bar, cutout and keyboard insets are applied on modern Android versions. Rotation keeps the current WebView alive.

An internet connection is required. The app has no offline write queue, push notifications, or background data synchronization. Native connection errors provide a retry action.

Version 1.1.0 adds expense receipt selection and receipt downloads. Install the update using the same distribution signing key as 1.0.0; the application ID and existing WebView sign-in profile are retained. The CRM's other new modules load from the live website. Version 1.0.0 users can use **Open in browser** for receipt uploads until they update.

## Security and navigation

`UriPolicy` is the single policy for navigation, incoming links, downloads and bridge origins. Only HTTPS on the exact CRM host with the default port or port 443 can navigate inside the WebView. Userinfo, host suffix tricks, other ports, arbitrary schemes, file/content URLs and insecure HTTP are rejected.

External HTTPS, telephone and email links can open a system handler only after a main-frame user gesture. Telephone links open the dialer and email links open a composer; the app does not call or send email. The native Open in browser menu opens the normal workspace origin, never a private activation URL.

The existing site's only third-party resource exceptions are HTTPS GET requests for Google Fonts CSS from `fonts.googleapis.com/css` or `/css2`, and font files under `fonts.gstatic.com/s/`. Other external resources are blocked. A system sans-serif fallback works if the font service is unavailable. Native export downloads never send CRM cookies to these hosts.

Mixed content and WebView file/content access are disabled. SSL errors are cancelled. Third-party cookies, automatic JavaScript popups and release WebView debugging are disabled. First-party session cookies are kept within the app's WebView profile. Android backup/device transfer is disabled. The APK contains no account passwords, Supabase secret keys or provider credentials.

## Account setup and recovery links

The Activity accepts incoming HTTPS links only on the exact CRM host and `/auth/confirm` path. It preserves the private fragment in memory while loading the existing confirmation page. The page handles confirmation and removes its token fragment normally. The native app does not log or save fragments in Bundles, preferences, files or analytics; it clears the incoming Activity Intent after reading it.

The manifest requests verified App Links. To enable automatic opening in the installed app, publish `/.well-known/assetlinks.json` on the CRM origin with `com.smartconstruction.crm` and the SHA-256 certificate fingerprint of the **actual distribution signing key**. Do not invent a certificate fingerprint or copy a temporary debug certificate into production association. Until verification succeeds, Android may open these links in the browser; the website flow remains available there.

## CSV, JSON and printing

The app exposes `SmartConstructionNative` using AndroidX `WebViewCompat.addWebMessageListener` with the exact HTTPS origin rule. Each message also requires the trusted main frame and exact source origin. There is no `addJavascriptInterface` bridge.

The web helper sends these JSON messages:

```json
{"type":"print"}
```

```json
{"type":"save-text","filename":"leads.csv","text":"Project,Stage\nExample,New\n","mime":"text/csv;charset=utf-8"}
```

Only CSV, JSON and plain text MIME types are accepted. Text is encoded as UTF-8 and capped at 8 MiB. Filenames are sanitized and given the matching extension. Android's Storage Access Framework asks the user where to save each file. No storage permission is requested; export contents remain in memory until the selected document is written and are not staged in app files.

The existing `/api/export` download is supported separately. The native client requests only that exact same-origin endpoint, uses current session cookies privately, refuses redirects, requires a successful JSON response and enforces the same 8 MiB limit before opening the system Save dialog. Cancelling a save discards the pending data. If Android destroys the process during the system picker, start the export again.

Open the quotation and choose its **Print** action to print or save a PDF. The CRM prepares that quotation and applies its print styles before calling Android's print framework through `WebView.createPrintDocumentAdapter`. The native menu does not print arbitrary CRM pages because their normal dashboard layout is hidden by the site's print stylesheet. Only one print job is active at a time. Printer availability and detailed pagination depend on the device's print service; a physical-device check is part of release acceptance.

If an old System WebView lacks origin-scoped web messaging, the bridge is not installed. Update Android System WebView or use Open in browser for quotation printing and text exports.

## Expense receipts

The receipt file input opens Android's `ACTION_OPEN_DOCUMENT` picker for one JPG, PNG, WebP or PDF. This is available only while the current CRM page is fully loaded on the trusted origin. It does not request camera, media-library or broad storage permissions. A user can take a receipt photo with their normal camera app and select that saved file.

Only a selected `content://` document is accepted. File paths, HTTP URLs, ambiguous authorities, multiple selections, the app's own content-provider authorities, and any provider owned by the app package are rejected. The native client verifies the declared type, reported size where available, bounded actual bytes and basic file signature before returning the URI to WebView. The limit is 3 MiB per receipt. This validation does not replace the server's independent signature, size, authenticated membership and expense-ownership checks. No persistent URI grant is requested and the native client does not stage the receipt in app files.

The pending chooser is cancelled on page navigation, connection failure, renderer loss or Activity destruction. Results are bound to the requesting page and generation; stale picker callbacks cannot populate a later page. Cancelling the system picker returns no file.

Receipt download links use only the exact same-origin `/api/expense-receipts/<UUID>` endpoint, with no query or fragment. The native request sends the current CRM cookies only to that endpoint, rejects redirects and non-200 responses, permits the same four MIME types, and checks the actual size and signature before opening the Save dialog. Filenames use a fixed safe receipt name with the matching extension. Native cookies are never forwarded to document providers or external download hosts. The endpoint rechecks the member's access on the server. Navigation during a request discards its pending bytes. The existing `/api/export` JSON flow retains its separate 8 MiB limit and the native web-message bridge still accepts only text exports.

## Build and verification

Use a JDK 17 installation and an already licensed Android SDK containing platform 36 and build tools 36.0.0. Set `ANDROID_HOME` or a local uncommitted `local.properties`. SDK auto-download is disabled; the repository does not accept SDK licenses on the user's behalf.

From this directory:

```sh
./gradlew --no-daemon -Pandroid.builder.sdkDownload=false testDebugUnitTest lintDebug assembleRelease assembleDebug
```

On Windows use `gradlew.bat` with the same arguments. The GitHub Android build workflow checks the runner's existing JDK/SDK, runs these gates and uploads APKs and reports. It does not install SDK packages or accept license prompts.

- Debug APK: `app/build/outputs/apk/debug/app-debug.apk` — development testing only, debug-signed and debuggable.
- Release APK before signing: `app/build/outputs/apk/release/app-release-unsigned.apk` — must be signed with the retained distribution key before employees can install it.

Keep the release signing key outside the repository. Retain it for all future updates; changing the signing identity prevents an ordinary in-place update. The Play Console/AAB path is a separate distribution decision.

Pure-Java unit tests cover trusted origin matching, deceptive hosts, userinfo, ports, unsafe schemes, incoming auth paths, exact export and receipt URLs, gesture requirements, static font exceptions, UTF-8 byte limits, receipt type/signature/size checks, document URI rejection and safe filenames. Android compilation, lint and APK generation require the actual SDK. Build success does not replace phone testing of login, an employee role, removal, keyboard behavior, rotation, Back, recovery links, receipt selection/cancellation/download, CSV/JSON saves and quotation printing.

## Primary references

- [AGP 8.13 compatibility and 8.13.2](https://developer.android.com/build/releases/agp-8-13-0-release-notes)
- [AndroidX WebKit releases](https://developer.android.com/jetpack/androidx/releases/webkit)
- [Origin-scoped WebView messaging](https://developer.android.com/reference/androidx/webkit/WebViewCompat#addWebMessageListener(android.webkit.WebView,java.lang.String,java.util.Set,androidx.webkit.WebViewCompat.WebMessageListener))
- [WebMessageListener source origin and frame](https://developer.android.com/reference/androidx/webkit/WebViewCompat.WebMessageListener)
- [System-bar and cutout insets](https://developer.android.com/develop/ui/views/layout/edge-to-edge)
- [Storage Access Framework](https://developer.android.com/training/data-storage/shared/documents-files)
- [WebView file chooser and URI validation](https://developer.android.com/reference/android/webkit/WebChromeClient#onShowFileChooser(android.webkit.WebView,android.webkit.ValueCallback,android.webkit.WebChromeClient.FileChooserParams))
- [Printing HTML documents](https://developer.android.com/training/printing/html-docs)
