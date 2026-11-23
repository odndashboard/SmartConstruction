package com.smartconstruction.crm;

import java.nio.charset.StandardCharsets;
import java.util.Locale;

/** Text-only native exports; a system document picker chooses the destination. */
public final class ExportPolicy {
    public static final int MAX_BYTES = 8 * 1024 * 1024;

    private ExportPolicy() { }

    public static String normalizedMime(String value) {
        if (value == null) return null;
        String mime = value.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        return "text/csv".equals(mime) || "application/json".equals(mime)
                || "text/plain".equals(mime) ? mime : null;
    }

    public static byte[] utf8(String text) {
        if (text == null || text.length() > MAX_BYTES) throw new IllegalArgumentException("EXPORT_SIZE");
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_BYTES) throw new IllegalArgumentException("EXPORT_SIZE");
        return bytes;
    }

    public static String filename(String suggested, String mime) {
        String extension = "application/json".equals(mime) ? ".json" : "text/csv".equals(mime) ? ".csv" : ".txt";
        String name = suggested == null ? "" : suggested.replaceAll("[^A-Za-z0-9._ -]", "_").replaceAll("^[. ]+", "");
        if (name.length() > 100) name = name.substring(0, 100);
        if (name.trim().isEmpty()) name = "smart-construction-export";
        return name.toLowerCase(Locale.ROOT).endsWith(extension) ? name : name + extension;
    }
}
