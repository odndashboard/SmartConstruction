package com.smartconstruction.crm;

import org.junit.Test;
import static org.junit.Assert.*;

public final class ExportPolicyTest {
    @Test public void acceptedTypesRemainTextOnly() {
        assertEquals("text/csv", ExportPolicy.normalizedMime("text/csv;charset=utf-8;"));
        assertEquals("application/json", ExportPolicy.normalizedMime("application/json"));
        assertNull(ExportPolicy.normalizedMime("text/html"));
        assertNull(ExportPolicy.normalizedMime("application/octet-stream"));
    }

    @Test public void sizeCapUsesUtf8BytesNotCharacterCount() {
        assertEquals(3, ExportPolicy.utf8("₹").length);
        String oversized = "₹".repeat(ExportPolicy.MAX_BYTES / 3 + 1);
        assertThrows(IllegalArgumentException.class, () -> ExportPolicy.utf8(oversized));
    }

    @Test public void filenamesCannotChoosePathsOrExecutableExtensions() {
        assertEquals("leads.csv", ExportPolicy.filename("leads.csv", "text/csv"));
        String safe = ExportPolicy.filename("../../private<script>.html", "application/json");
        assertFalse(safe.contains("/"));
        assertFalse(safe.contains("<"));
        assertTrue(safe.endsWith(".json"));
        assertEquals("smart-construction-export.txt", ExportPolicy.filename("...", "text/plain"));
    }
}
