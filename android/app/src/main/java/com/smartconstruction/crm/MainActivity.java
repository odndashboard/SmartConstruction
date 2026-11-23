package com.smartconstruction.crm;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ProviderInfo;
import android.database.Cursor;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.print.PrintAttributes;
import android.print.PrintJob;
import android.print.PrintManager;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.ValueCallback;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.RequiresApi;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.util.Arrays;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.HttpsURLConnection;

/** A single-origin client for the existing CRM; all roles remain server-enforced. */
public final class MainActivity extends Activity {
    private static final String BRIDGE_NAME = "SmartConstructionNative";
    private static final int CREATE_DOCUMENT = 1001;
    private static final int FIRST_OPEN_RECEIPT = 1100;
    private static final String BACK_EVENT_SCRIPT =
            "(function(){return !window.dispatchEvent(new Event('smart-construction-back',{cancelable:true}));})()";

    private final ExecutorService fileExecutor = Executors.newSingleThreadExecutor();
    private WebView webView;
    private LinearLayout root;
    private FrameLayout content;
    private LinearLayout connectionPanel;
    private TextView connectionTitle;
    private TextView connectionDetail;
    private Button retryButton;
    private ProgressBar progress;
    private String retryUrl = UriPolicy.HOME;
    private boolean pageLoaded;
    private boolean mainFrameFailed;
    private boolean exportBusy;
    private boolean backPending;
    private PendingExport pendingExport;
    private PrintJob printJob;
    private Runnable unregisterBack;
    private ValueCallback<Uri[]> receiptCallback;
    private String receiptPageUrl;
    private int receiptRequestCode = -1;
    private int nextReceiptRequestCode = FIRST_OPEN_RECEIPT;
    private long pageGeneration;

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        createShell();
        configureSystemBars();
        if (Build.VERSION.SDK_INT >= 33) unregisterBack = BackApi33.register(this, this::handleBack);
        String entry = incomingAuthLink(getIntent());
        // Do not keep a private activation fragment in this Activity's Intent.
        setIntent(new Intent(this, MainActivity.class).setAction(Intent.ACTION_MAIN));
        loadWorkspace(entry == null ? UriPolicy.HOME : entry);
    }

    private void createShell() {
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(getColor(R.color.navy));

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(14), 0, dp(6), 0);
        ImageView brand = new ImageView(this);
        brand.setImageResource(R.drawable.ic_brand);
        brand.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        header.addView(brand, new LinearLayout.LayoutParams(dp(34), dp(34)));
        TextView title = new TextView(this);
        title.setText(R.string.brand_name);
        title.setTextColor(Color.WHITE);
        title.setTextSize(16);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        title.setPadding(dp(10), 0, 0, 0);
        header.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        ImageButton more = new ImageButton(this);
        more.setImageResource(R.drawable.ic_more);
        more.setBackgroundColor(Color.TRANSPARENT);
        more.setContentDescription(getString(R.string.more_options));
        more.setOnClickListener(this::showMenu);
        header.addView(more, new LinearLayout.LayoutParams(dp(48), dp(48)));
        root.addView(header, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(54)));

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        progress.setProgressTintList(ColorStateList.valueOf(getColor(R.color.gold)));
        progress.setProgressBackgroundTintList(ColorStateList.valueOf(getColor(R.color.navy)));
        root.addView(progress, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3)));
        content = new FrameLayout(this);
        content.setBackgroundColor(getColor(R.color.paper));
        root.addView(content, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));

        connectionPanel = new LinearLayout(this);
        connectionPanel.setOrientation(LinearLayout.VERTICAL);
        connectionPanel.setGravity(Gravity.CENTER);
        connectionPanel.setPadding(dp(30), dp(30), dp(30), dp(30));
        connectionPanel.setBackgroundColor(getColor(R.color.paper));
        ImageView mark = new ImageView(this);
        mark.setImageResource(R.drawable.ic_brand);
        GradientDrawable badge = new GradientDrawable();
        badge.setColor(getColor(R.color.navy));
        badge.setCornerRadius(dp(20));
        mark.setBackground(badge);
        mark.setPadding(dp(14), dp(14), dp(14), dp(14));
        mark.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        connectionPanel.addView(mark, new LinearLayout.LayoutParams(dp(82), dp(82)));
        connectionTitle = new TextView(this);
        connectionTitle.setTextSize(22);
        connectionTitle.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        connectionTitle.setTextColor(getColor(R.color.ink));
        connectionTitle.setGravity(Gravity.CENTER);
        connectionTitle.setPadding(0, dp(26), 0, dp(12));
        connectionPanel.addView(connectionTitle);
        connectionDetail = new TextView(this);
        connectionDetail.setTextSize(14);
        connectionDetail.setTextColor(getColor(R.color.muted));
        connectionDetail.setGravity(Gravity.CENTER);
        connectionDetail.setLineSpacing(dp(3), 1);
        connectionPanel.addView(connectionDetail);
        retryButton = new Button(this);
        retryButton.setText(R.string.retry);
        retryButton.setTextColor(getColor(R.color.navy));
        retryButton.setBackgroundTintList(ColorStateList.valueOf(getColor(R.color.gold)));
        retryButton.setOnClickListener(v -> loadWorkspace(retryUrl));
        LinearLayout.LayoutParams retryLayout = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(48));
        retryLayout.topMargin = dp(24);
        connectionPanel.addView(retryButton, retryLayout);
        content.addView(connectionPanel, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        showConnecting();
    }

    @SuppressWarnings("deprecation")
    private void configureSystemBars() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            getWindow().setStatusBarColor(Color.TRANSPARENT);
            getWindow().setNavigationBarColor(Color.TRANSPARENT);
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) controller.setSystemBarsAppearance(0,
                    WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                            | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets keyboard = insets.getInsets(WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
                return WindowInsets.CONSUMED;
            });
            root.requestApplyInsets();
        } else {
            getWindow().setStatusBarColor(getColor(R.color.navy));
            getWindow().setNavigationBarColor(getColor(R.color.navy));
        }
    }

    @SuppressLint("SetJavaScriptEnabled") // Required by the CRM; origin checks and no generic JS interface are enforced below.
    @SuppressWarnings("deprecation")
    private void installWebView() {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        WebView view = new WebView(this);
        webView = view;
        view.setSaveEnabled(false);
        view.setBackgroundColor(getColor(R.color.paper));
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSaveFormData(false);
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setUserAgentString(settings.getUserAgentString() + " SmartConstructionAndroid/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false);
        view.setWebViewClient(new WorkspaceClient());
        view.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView ignored, int value) {
                progress.setProgress(value);
                progress.setVisibility(value < 100 && !mainFrameFailed ? View.VISIBLE : View.INVISIBLE);
            }
            @Override public boolean onConsoleMessage(ConsoleMessage ignored) {
                // Web content can include account details; never copy console output to native logs.
                return true;
            }
            @Override public boolean onShowFileChooser(WebView source, ValueCallback<Uri[]> callback,
                                                       FileChooserParams parameters) {
                return chooseReceipt(source, callback, parameters);
            }
        });
        view.setDownloadListener((url, userAgent, contentDisposition, mimeType, length) -> prepareWorkspaceDownload(url, userAgent));

        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(view, BRIDGE_NAME,
                    Collections.singleton(UriPolicy.ORIGIN), (sourceView, message, sourceOrigin, isMainFrame, replyProxy) -> {
                        if (!isMainFrame || !UriPolicy.isExactOrigin(sourceOrigin.toString())
                                || !UriPolicy.isInternal(sourceView.getUrl())
                                || message.getType() != WebMessageCompat.TYPE_STRING) return;
                        handleNativeMessage(message.getData());
                    });
        }
        ServiceWorkerController workers = ServiceWorkerController.getInstance();
        workers.getServiceWorkerWebSettings().setAllowFileAccess(false);
        workers.getServiceWorkerWebSettings().setAllowContentAccess(false);
        workers.setServiceWorkerClient(new WorkspaceWorkerClient());
        content.addView(view, 0, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private static final class WorkspaceWorkerClient extends ServiceWorkerClient {
        @Override public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
            return UriPolicy.isAllowedResource(request.getUrl().toString(), request.getMethod()) ? null : blockedResource();
        }
    }

    private final class WorkspaceClient extends WebViewClient {
        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            String url = request.getUrl().toString();
            if (request.isForMainFrame() && (UriPolicy.isWorkspaceExport(url) || UriPolicy.isExpenseReceipt(url))) {
                if (request.hasGesture() && !request.isRedirect()) {
                    prepareWorkspaceDownload(url, view.getSettings().getUserAgentString());
                } else notifyUser(R.string.unsupported_download);
                return true;
            }
            if (UriPolicy.isInternal(url)) return false;
            if (request.isForMainFrame() && UriPolicy.mayOpenExternal(url, request.hasGesture() && !request.isRedirect())) {
                launchExternal(request.getUrl());
            } else if (request.isForMainFrame() && request.hasGesture()) {
                notifyUser(R.string.link_blocked);
            }
            return true;
        }
        @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            boolean allowed = request.isForMainFrame() ? UriPolicy.isInternal(request.getUrl().toString())
                    : UriPolicy.isAllowedResource(request.getUrl().toString(), request.getMethod());
            return allowed ? null : blockedResource();
        }
        @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
            pageGeneration++;
            cancelReceiptPicker();
            if (!UriPolicy.isInternal(url)) {
                view.stopLoading();
                showFailure(false);
                return;
            }
            retryUrl = url;
            pageLoaded = false;
            mainFrameFailed = false;
            progress.setVisibility(View.VISIBLE);
        }
        @Override public void doUpdateVisitedHistory(WebView view, String url, boolean reload) {
            if (receiptCallback != null && !url.equals(receiptPageUrl)) cancelReceiptPicker();
        }
        @Override public void onPageFinished(WebView view, String url) {
            if (!mainFrameFailed && UriPolicy.isInternal(view.getUrl())) {
                pageLoaded = true;
                retryUrl = view.getUrl();
                connectionPanel.setVisibility(View.GONE);
                CookieManager.getInstance().flush();
            }
            progress.setVisibility(View.INVISIBLE);
        }
        @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) showFailure(false);
        }
        @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (request.isForMainFrame() && response.getStatusCode() >= 400) showFailure(false);
        }
        @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel();
            if (UriPolicy.isInternal(error.getUrl())) showFailure(true);
        }
        @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            pageGeneration++;
            cancelReceiptPicker();
            content.removeView(view);
            view.destroy();
            webView = null;
            showFailure(false);
            return true;
        }
    }

    private static WebResourceResponse blockedResource() {
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked",
                Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    private void loadWorkspace(String url) {
        cancelReceiptPicker();
        if (!UriPolicy.isInternal(url)) url = UriPolicy.HOME;
        retryUrl = url;
        showConnecting();
        try {
            if (webView == null) installWebView();
            webView.loadUrl(url);
        } catch (RuntimeException ignored) {
            if (webView != null) {
                content.removeView(webView);
                webView.destroy();
                webView = null;
            }
            showFailure(false);
            connectionDetail.setText(R.string.webview_unavailable);
        }
    }

    private void showConnecting() {
        pageLoaded = false;
        mainFrameFailed = false;
        connectionTitle.setText(R.string.opening_title);
        connectionDetail.setText(R.string.opening_detail);
        retryButton.setVisibility(View.GONE);
        connectionPanel.setVisibility(View.VISIBLE);
        progress.setVisibility(View.VISIBLE);
    }

    private void showFailure(boolean secure) {
        cancelReceiptPicker();
        mainFrameFailed = true;
        pageLoaded = false;
        connectionTitle.setText(secure ? R.string.secure_error_title : R.string.offline_title);
        connectionDetail.setText(secure ? R.string.secure_error_detail : R.string.offline_detail);
        retryButton.setVisibility(View.VISIBLE);
        connectionPanel.setVisibility(View.VISIBLE);
        progress.setVisibility(View.INVISIBLE);
    }

    private void showMenu(View anchor) {
        PopupMenu menu = new PopupMenu(this, anchor);
        menu.getMenu().add(0, 1, 0, R.string.refresh);
        menu.getMenu().add(0, 2, 1, R.string.open_browser);
        menu.setOnMenuItemClickListener(item -> {
            if (item.getItemId() == 1) loadWorkspace(webView != null && UriPolicy.isInternal(webView.getUrl()) ? webView.getUrl() : UriPolicy.HOME);
            // Always open the normal workspace address, never a private account fragment.
            else if (item.getItemId() == 2) launchExternal(Uri.parse(UriPolicy.HOME));
            return true;
        });
        menu.show();
    }

    private void launchExternal(Uri uri) {
        String scheme = uri.getScheme();
        String action = "tel".equalsIgnoreCase(scheme) ? Intent.ACTION_DIAL
                : "mailto".equalsIgnoreCase(scheme) ? Intent.ACTION_SENDTO : Intent.ACTION_VIEW;
        Intent intent = new Intent(action, uri);
        if (Intent.ACTION_VIEW.equals(action)) intent.addCategory(Intent.CATEGORY_BROWSABLE);
        try { startActivity(intent); }
        catch (ActivityNotFoundException | SecurityException ignored) { notifyUser(R.string.no_link_handler); }
    }

    private String incomingAuthLink(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction()) || intent.getData() == null) return null;
        String value = intent.getData().toString();
        return UriPolicy.isAuthLink(value) ? value : null;
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String link = incomingAuthLink(intent);
        setIntent(new Intent(this, MainActivity.class).setAction(Intent.ACTION_MAIN));
        if (link != null) loadWorkspace(link);
        else if (Intent.ACTION_VIEW.equals(intent.getAction())) notifyUser(R.string.link_blocked);
    }

    private void handleNativeMessage(String raw) {
        if (raw == null || raw.length() > ExportPolicy.MAX_BYTES + 8192) {
            notifyUser(R.string.export_too_large);
            return;
        }
        try {
            JSONObject message = new JSONObject(raw);
            String type = message.getString("type");
            if ("print".equals(type)) {
                printCurrentPage();
            } else if ("save-text".equals(type)) {
                if (exportBusy || pendingExport != null) { notifyUser(R.string.export_busy); return; }
                String mime = ExportPolicy.normalizedMime(message.getString("mime"));
                if (mime == null) { notifyUser(R.string.unsupported_download); return; }
                byte[] bytes = ExportPolicy.utf8(message.getString("text"));
                beginSave(bytes, ExportPolicy.filename(message.getString("filename"), mime), mime);
            }
        } catch (JSONException ignored) {
            notifyUser(R.string.unsupported_download);
        } catch (IllegalArgumentException ignored) {
            notifyUser(R.string.export_too_large);
        }
    }

    private void printCurrentPage() {
        if (webView == null || !pageLoaded || !UriPolicy.isInternal(webView.getUrl())) {
            notifyUser(R.string.wait_for_page); return;
        }
        if (printJob != null && !printJob.isCompleted() && !printJob.isCancelled() && !printJob.isFailed()) {
            notifyUser(R.string.print_in_progress); return;
        }
        PrintManager manager = (PrintManager) getSystemService(PRINT_SERVICE);
        if (manager == null) { notifyUser(R.string.print_unavailable); return; }
        try {
            String name = getString(R.string.print_job_name);
            printJob = manager.print(name, webView.createPrintDocumentAdapter(name), new PrintAttributes.Builder().build());
        } catch (RuntimeException ignored) { notifyUser(R.string.print_unavailable); }
    }

    private void prepareWorkspaceDownload(String url, String userAgent) {
        final boolean receipt = UriPolicy.isExpenseReceipt(url);
        if ((!receipt && !UriPolicy.isWorkspaceExport(url)) || webView == null
                || mainFrameFailed || !UriPolicy.isInternal(webView.getUrl())) {
            notifyUser(R.string.unsupported_download); return;
        }
        if (exportBusy || pendingExport != null) { notifyUser(R.string.export_busy); return; }
        exportBusy = true;
        final long generation = pageGeneration;
        final String sourceUrl = webView.getUrl();
        final int limit = receipt ? ReceiptPolicy.MAX_BYTES : ExportPolicy.MAX_BYTES;
        // Session cookies stay in memory and are sent only to an exact authorized CRM endpoint.
        final String cookies = CookieManager.getInstance().getCookie(url);
        fileExecutor.execute(() -> {
            HttpsURLConnection connection = null;
            try {
                connection = (HttpsURLConnection) new URL(url).openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(15_000);
                connection.setReadTimeout(30_000);
                connection.setUseCaches(false);
                connection.setRequestProperty("Accept", receipt ? "image/jpeg,image/png,image/webp,application/pdf" : "application/json");
                connection.setRequestProperty("Cache-Control", "no-store");
                if (userAgent != null) connection.setRequestProperty("User-Agent", userAgent);
                if (cookies != null && !cookies.isEmpty()) connection.setRequestProperty("Cookie", cookies);
                String responseMime = receipt ? ReceiptPolicy.normalizedMime(connection.getContentType())
                        : ExportPolicy.normalizedMime(connection.getContentType());
                if (connection.getResponseCode() != 200 || responseMime == null
                        || (!receipt && !"application/json".equals(responseMime))) {
                    throw new IOException("EXPORT_REJECTED");
                }
                if (connection.getContentLengthLong() > limit) throw new ExportTooLargeException();
                byte[] bytes;
                try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                    byte[] buffer = new byte[8192];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        if (output.size() + count > limit) throw new ExportTooLargeException();
                        output.write(buffer, 0, count);
                    }
                    bytes = output.toByteArray();
                }
                if (receipt && !ReceiptPolicy.matchesSignature(bytes, responseMime)) {
                    Arrays.fill(bytes, (byte) 0);
                    throw new IOException("RECEIPT_TYPE");
                }
                runOnUiThread(() -> {
                    exportBusy = false;
                    if (isFinishing() || isDestroyed() || pageGeneration != generation || webView == null
                            || !sourceUrl.equals(webView.getUrl())) Arrays.fill(bytes, (byte) 0);
                    else beginSave(bytes, receipt ? ReceiptPolicy.filename(responseMime)
                            : "smart-construction-workspace.json", responseMime);
                });
            } catch (IOException | RuntimeException error) {
                final int message = error instanceof ExportTooLargeException
                        ? (receipt ? R.string.receipt_too_large : R.string.export_too_large)
                        : (receipt ? R.string.receipt_failed : R.string.export_failed);
                runOnUiThread(() -> { exportBusy = false; notifyUser(message); });
            } finally { if (connection != null) connection.disconnect(); }
        });
    }

    @SuppressWarnings("deprecation")
    private boolean chooseReceipt(WebView source, ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams parameters) {
        cancelReceiptPicker();
        if (source != webView || !pageLoaded || mainFrameFailed || !UriPolicy.isInternal(source.getUrl())
                || parameters.getMode() != WebChromeClient.FileChooserParams.MODE_OPEN) {
            callback.onReceiveValue(null);
            notifyUser(R.string.receipt_invalid);
            return true;
        }
        receiptCallback = callback;
        receiptPageUrl = source.getUrl();
        receiptRequestCode = nextReceiptRequestCode++;
        if (nextReceiptRequestCode > 65_000) nextReceiptRequestCode = FIRST_OPEN_RECEIPT;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, ReceiptPolicy.MIME_TYPES.clone());
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try { startActivityForResult(intent, receiptRequestCode); }
        catch (ActivityNotFoundException | SecurityException ignored) {
            cancelReceiptPicker();
            notifyUser(R.string.save_unavailable);
        }
        return true;
    }

    private void cancelReceiptPicker() {
        ValueCallback<Uri[]> callback = receiptCallback;
        receiptCallback = null;
        receiptPageUrl = null;
        receiptRequestCode = -1;
        if (callback != null) callback.onReceiveValue(null);
    }

    @SuppressWarnings("deprecation")
    private void acceptReceiptSelection(int resultCode, Intent data) {
        final ValueCallback<Uri[]> callback = receiptCallback;
        final String sourceUrl = receiptPageUrl;
        final long generation = pageGeneration;
        receiptRequestCode = -1;
        Uri selected = data == null ? null : data.getData();
        boolean multiple = data != null && data.getClipData() != null && data.getClipData().getItemCount() != 1;
        if (callback == null || resultCode != RESULT_OK || selected == null || multiple || webView == null
                || !pageLoaded || !sourceUrl.equals(webView.getUrl())
                || !ReceiptPolicy.isExternalDocument(selected.toString(), getPackageName())) {
            cancelReceiptPicker();
            if (resultCode == RESULT_OK) notifyUser(R.string.receipt_invalid);
            return;
        }
        fileExecutor.execute(() -> {
            boolean permitted = false;
            try {
                ProviderInfo provider = getPackageManager().resolveContentProvider(selected.getAuthority(), 0);
                if (provider != null && getPackageName().equals(provider.packageName)) throw new IOException("OWN_PROVIDER");
                String mime = ReceiptPolicy.normalizedMime(getContentResolver().getType(selected));
                if (mime == null) throw new IOException("RECEIPT_TYPE");
                try (Cursor cursor = getContentResolver().query(selected, new String[]{OpenableColumns.SIZE}, null, null, null)) {
                    if (cursor != null && cursor.moveToFirst()) {
                        int sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE);
                        if (sizeColumn >= 0 && !cursor.isNull(sizeColumn)
                                && !ReceiptPolicy.permittedReportedSize(cursor.getLong(sizeColumn))) throw new IOException("RECEIPT_SIZE");
                    }
                }
                // Validate unknown/misreported sizes too. No receipt is copied into private app storage.
                try (InputStream input = getContentResolver().openInputStream(selected);
                     ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                    if (input == null) throw new IOException("NO_INPUT");
                    byte[] buffer = new byte[8192];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        if (output.size() + count > ReceiptPolicy.MAX_BYTES) throw new IOException("RECEIPT_SIZE");
                        output.write(buffer, 0, count);
                    }
                    byte[] bytes = output.toByteArray();
                    permitted = ReceiptPolicy.matchesSignature(bytes, mime);
                    Arrays.fill(bytes, (byte) 0);
                }
            } catch (IOException | RuntimeException ignored) { /* The server independently verifies every upload. */ }
            final boolean accepted = permitted;
            runOnUiThread(() -> {
                if (receiptCallback != callback) return;
                receiptCallback = null;
                receiptPageUrl = null;
                boolean current = !isFinishing() && !isDestroyed() && webView != null && pageLoaded
                        && pageGeneration == generation && sourceUrl.equals(webView.getUrl());
                callback.onReceiveValue(accepted && current ? new Uri[]{selected} : null);
                if (current && !accepted) notifyUser(R.string.receipt_invalid);
            });
        });
    }

    @SuppressWarnings("deprecation")
    private void beginSave(byte[] bytes, String filename, String mime) {
        if (pendingExport != null || exportBusy) {
            Arrays.fill(bytes, (byte) 0); notifyUser(R.string.export_busy); return;
        }
        pendingExport = new PendingExport(bytes);
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime);
        intent.putExtra(Intent.EXTRA_TITLE, filename);
        try { startActivityForResult(intent, CREATE_DOCUMENT); }
        catch (ActivityNotFoundException | SecurityException ignored) {
            pendingExport = null;
            Arrays.fill(bytes, (byte) 0);
            notifyUser(R.string.save_unavailable);
        }
    }

    @SuppressWarnings("deprecation")
    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode >= FIRST_OPEN_RECEIPT) {
            if (requestCode == receiptRequestCode) acceptReceiptSelection(resultCode, data);
            return;
        }
        if (requestCode != CREATE_DOCUMENT) return;
        PendingExport saved = pendingExport;
        pendingExport = null;
        if (saved == null) { if (resultCode == RESULT_OK) notifyUser(R.string.save_failed); return; }
        Uri destination = data == null ? null : data.getData();
        if (resultCode != RESULT_OK || destination == null || !"content".equals(destination.getScheme())) {
            Arrays.fill(saved.bytes, (byte) 0); return;
        }
        exportBusy = true;
        fileExecutor.execute(() -> {
            int message = R.string.save_success;
            try (OutputStream output = getContentResolver().openOutputStream(destination, "w")) {
                if (output == null) throw new IOException("NO_OUTPUT");
                output.write(saved.bytes);
                output.flush();
            } catch (IOException | RuntimeException ignored) { message = R.string.save_failed; }
            finally { Arrays.fill(saved.bytes, (byte) 0); }
            final int resultMessage = message;
            runOnUiThread(() -> { exportBusy = false; notifyUser(resultMessage); });
        });
    }

    private void handleBack() {
        if (backPending) return;
        if (webView != null && pageLoaded && UriPolicy.isInternal(webView.getUrl())) {
            backPending = true;
            webView.evaluateJavascript(BACK_EVENT_SCRIPT, result -> {
                backPending = false;
                if (!"true".equals(result)) navigateBack();
            });
        } else navigateBack();
    }

    private void navigateBack() {
        if (isFinishing() || isDestroyed()) return;
        if (webView != null && webView.canGoBack()) webView.goBack();
        else finish();
    }

    // Android 8–12 use this legacy hook. API 33+ registers OnBackInvokedCallback
    // in onCreate; gesture handling on modern Android does not depend on this override.
    @SuppressLint("GestureBackNavigation")
    @SuppressWarnings("deprecation")
    @Override public void onBackPressed() { handleBack(); }

    @RequiresApi(33)
    private static final class BackApi33 {
        static Runnable register(Activity activity, Runnable back) {
            android.window.OnBackInvokedCallback callback = back::run;
            activity.getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback);
            return () -> activity.getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(callback);
        }
    }

    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        root.requestApplyInsets();
    }

    @Override protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override protected void onPause() {
        if (webView != null) {
            webView.onPause();
            CookieManager.getInstance().flush();
        }
        super.onPause();
    }

    @Override protected void onDestroy() {
        cancelReceiptPicker();
        if (unregisterBack != null) unregisterBack.run();
        if (pendingExport != null) { Arrays.fill(pendingExport.bytes, (byte) 0); pendingExport = null; }
        fileExecutor.shutdownNow();
        if (webView != null) {
            webView.stopLoading();
            content.removeView(webView);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private void notifyUser(int resource) {
        if (!isFinishing() && !isDestroyed()) Toast.makeText(this, resource, Toast.LENGTH_LONG).show();
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private static final class PendingExport {
        final byte[] bytes;
        PendingExport(byte[] bytes) { this.bytes = bytes; }
    }
    private static final class ExportTooLargeException extends IOException { }
}
