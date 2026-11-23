package com.smartconstruction.crm;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/** Receipt files use a separate, bounded policy; the native text bridge remains text-only. */
public final class ReceiptPolicy {
    public static final int MAX_BYTES = 3 * 1024 * 1024;
    public static final String[] MIME_TYPES = {"image/jpeg", "image/png", "image/webp", "application/pdf"};

    private ReceiptPolicy() { }

    public static String normalizedMime(String value) {
        if (value == null) return null;
        String mime = value.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        for (String permitted : MIME_TYPES) if (permitted.equals(mime)) return mime;
        return null;
    }

    /** Unknown provider size is checked while reading; zero and oversize files are rejected. */
    public static boolean permittedReportedSize(long size) {
        return size == -1 || (size > 0 && size <= MAX_BYTES);
    }

    public static boolean isExternalDocument(String value, String ownPackage) {
        if (value == null || value.length() > 65_536 || !value.equals(value.trim())
                || value.indexOf('\\') >= 0 || ownPackage == null) return false;
        try {
            URI uri = new URI(value);
            String authority = uri.getRawAuthority();
            return !uri.isOpaque() && "content".equals(uri.getScheme())
                    && authority != null && authority.matches("[A-Za-z0-9._-]+")
                    && uri.getRawFragment() == null && uri.getRawPath() != null && !uri.getRawPath().isEmpty()
                    && !authority.equalsIgnoreCase(ownPackage)
                    && !authority.toLowerCase(Locale.ROOT).startsWith(ownPackage.toLowerCase(Locale.ROOT) + ".");
        } catch (URISyntaxException ignored) { return false; }
    }

    public static boolean matchesSignature(byte[] bytes, String mime) {
        if (bytes == null || bytes.length == 0 || bytes.length > MAX_BYTES) return false;
        if ("image/jpeg".equals(mime)) return bytes.length >= 3
                && (bytes[0] & 255) == 255 && (bytes[1] & 255) == 216 && (bytes[2] & 255) == 255;
        if ("image/png".equals(mime)) return bytes.length >= 24
                && (bytes[0] & 255) == 137 && bytes[1] == 80 && bytes[2] == 78 && bytes[3] == 71
                && bytes[4] == 13 && bytes[5] == 10 && bytes[6] == 26 && bytes[7] == 10
                && bytes[12] == 73 && bytes[13] == 72 && bytes[14] == 68 && bytes[15] == 82;
        if ("image/webp".equals(mime)) return bytes.length >= 12
                && bytes[0] == 82 && bytes[1] == 73 && bytes[2] == 70 && bytes[3] == 70
                && bytes[8] == 87 && bytes[9] == 69 && bytes[10] == 66 && bytes[11] == 80;
        return "application/pdf".equals(mime) && bytes.length >= 5
                && bytes[0] == 37 && bytes[1] == 80 && bytes[2] == 68 && bytes[3] == 70 && bytes[4] == 45;
    }

    public static String filename(String mime) {
        if ("image/jpeg".equals(mime)) return "smart-construction-receipt.jpg";
        if ("image/png".equals(mime)) return "smart-construction-receipt.png";
        if ("image/webp".equals(mime)) return "smart-construction-receipt.webp";
        if ("application/pdf".equals(mime)) return "smart-construction-receipt.pdf";
        throw new IllegalArgumentException("RECEIPT_TYPE");
    }
}
