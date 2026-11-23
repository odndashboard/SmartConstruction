package com.smartconstruction.crm;

import android.annotation.SuppressLint;
import android.annotation.TargetApi;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
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
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

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
        });
        view.setDownloadListener((url, userAgent, contentDisposition, mimeType, length) -> prepareWorkspaceExport(url, userAgent));

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
            if (request.isForMainFrame() && UriPolicy.isWorkspaceExport(url)) {
                if (request.hasGesture() && !request.isRedirect()) {
                    prepareWorkspaceExport(url, view.getSettings().getUserAgentString());
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

    private void prepareWorkspaceExport(String url, String userAgent) {
        if (!UriPolicy.isWorkspaceExport(url) || webView == null || !UriPolicy.isInternal(webView.getUrl())) {
            notifyUser(R.string.unsupported_download); return;
        }
        if (exportBusy || pendingExport != null) { notifyUser(R.string.export_busy); return; }
        exportBusy = true;
        // Session cookies stay in memory and are sent only to the exact CRM export endpoint.
        final String cookies = CookieManager.getInstance().getCookie(url);
        fileExecutor.execute(() -> {
            HttpsURLConnection connection = null;
            try {
                connection = (HttpsURLConnection) new URL(url).openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(15_000);
                connection.setReadTimeout(30_000);
                connection.setUseCaches(false);
                connection.setRequestProperty("Accept", "application/json");
                connection.setRequestProperty("Cache-Control", "no-store");
                if (userAgent != null) connection.setRequestProperty("User-Agent", userAgent);
                if (cookies != null && !cookies.isEmpty()) connection.setRequestProperty("Cookie", cookies);
                if (connection.getResponseCode() != 200 || !"application/json".equals(ExportPolicy.normalizedMime(connection.getContentType()))) {
                    throw new IOException("EXPORT_REJECTED");
                }
                if (connection.getContentLengthLong() > ExportPolicy.MAX_BYTES) throw new ExportTooLargeException();
                byte[] bytes;
                try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                    byte[] buffer = new byte[8192];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        if (output.size() + count > ExportPolicy.MAX_BYTES) throw new ExportTooLargeException();
                        output.write(buffer, 0, count);
                    }
                    bytes = output.toByteArray();
                }
                runOnUiThread(() -> {
                    exportBusy = false;
                    if (isFinishing() || isDestroyed()) Arrays.fill(bytes, (byte) 0);
                    else beginSave(bytes, "smart-construction-workspace.json", "application/json");
                });
            } catch (IOException | RuntimeException error) {
                final int message = error instanceof ExportTooLargeException ? R.string.export_too_large : R.string.export_failed;
                runOnUiThread(() -> { exportBusy = false; notifyUser(message); });
            } finally { if (connection != null) connection.disconnect(); }
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

    @SuppressWarnings("deprecation")
    @Override public void onBackPressed() { handleBack(); }

    @TargetApi(33)
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
