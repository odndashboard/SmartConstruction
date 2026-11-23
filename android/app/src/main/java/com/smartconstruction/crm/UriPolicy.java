package com.smartconstruction.crm;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/** Pure-Java policy shared by navigation, app links, downloads and unit tests. */
public final class UriPolicy {
    public static final String HOST = "smart-construction-dashboard.vercel.app";
    public static final String ORIGIN = "https://" + HOST;
    public static final String HOME = ORIGIN + "/";
    private static final int MAX_URL_LENGTH = 65_536;

    private UriPolicy() { }

    private static URI parse(String value) {
        if (value == null || value.isEmpty() || value.length() > MAX_URL_LENGTH
                || !value.equals(value.trim()) || value.indexOf('\\') >= 0) return null;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c <= 0x20 || c == 0x7f) return null;
        }
        try { return new URI(value); }
        catch (URISyntaxException ignored) { return null; }
    }

    private static boolean isHttps(URI uri) {
        return uri != null && !uri.isOpaque() && "https".equalsIgnoreCase(uri.getScheme())
                && uri.getHost() != null && !uri.getHost().isEmpty()
                && uri.getRawUserInfo() == null
                && (uri.getPort() == -1 || (uri.getPort() > 0 && uri.getPort() <= 65_535));
    }

    public static boolean isInternal(String value) {
        URI uri = parse(value);
        return isHttps(uri) && HOST.equalsIgnoreCase(uri.getHost())
                && (uri.getPort() == -1 || uri.getPort() == 443);
    }

    public static boolean isExactOrigin(String value) {
        URI uri = parse(value);
        return isInternal(value) && uri != null && uri.getRawQuery() == null
                && uri.getRawFragment() == null
                && (uri.getRawPath().isEmpty() || "/".equals(uri.getRawPath()));
    }

    public static boolean isAuthLink(String value) {
        URI uri = parse(value);
        return isInternal(value) && uri != null && "/auth/confirm".equals(uri.getRawPath());
    }

    public static boolean isWorkspaceExport(String value) {
        URI uri = parse(value);
        return isInternal(value) && uri != null && "/api/export".equals(uri.getRawPath())
                && uri.getRawQuery() == null && uri.getRawFragment() == null;
    }

    /** Static fonts are the only non-CRM subresources the existing site needs. */
    public static boolean isAllowedResource(String value, String method) {
        if (isInternal(value)) return true;
        URI uri = parse(value);
        if (!"GET".equalsIgnoreCase(method) || !isHttps(uri)
                || (uri.getPort() != -1 && uri.getPort() != 443)) return false;
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        String path = uri.getRawPath();
        return ("fonts.googleapis.com".equals(host)
                    && ("/css".equals(path) || "/css2".equals(path)))
                || ("fonts.gstatic.com".equals(host) && path.startsWith("/s/"));
    }

    /** Only a main-frame user gesture may dispatch a supported external URI. */
    public static boolean mayOpenExternal(String value, boolean userGesture) {
        if (!userGesture || isInternal(value)) return false;
        URI uri = parse(value);
        if (uri == null || uri.getScheme() == null) return false;
        if (isHttps(uri)) return true;
        String scheme = uri.getScheme().toLowerCase(Locale.ROOT);
        String destination = uri.getSchemeSpecificPart();
        if (destination == null || destination.isEmpty() || uri.getRawFragment() != null) return false;
        for (int i = 0; i < destination.length(); i++) {
            char c = destination.charAt(i);
            if (c < 0x20 || c == 0x7f) return false;
        }
        if ("tel".equals(scheme)) return destination.length() <= 64
                && destination.matches("[+0-9(). -]+");
        return "mailto".equals(scheme) && uri.isOpaque() && destination.length() <= 4096;
    }
}
