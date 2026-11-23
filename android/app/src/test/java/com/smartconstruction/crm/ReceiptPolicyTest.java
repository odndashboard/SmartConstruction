package com.smartconstruction.crm;

import java.nio.charset.StandardCharsets;
import org.junit.Test;
import static org.junit.Assert.*;

public final class ReceiptPolicyTest {
    private static final String APP = "com.smartconstruction.crm";

    @Test public void onlyReceiptImageAndPdfTypesAreAllowed() {
        assertEquals("image/jpeg", ReceiptPolicy.normalizedMime("IMAGE/JPEG; charset=binary"));
        for (String mime : ReceiptPolicy.MIME_TYPES) assertEquals(mime, ReceiptPolicy.normalizedMime(mime));
        for (String mime : new String[]{"image/svg+xml", "text/html", "application/json", "application/octet-stream", "image/gif", null}) {
            assertNull(ReceiptPolicy.normalizedMime(mime));
        }
        assertNull(ExportPolicy.normalizedMime("application/pdf"));
        assertNull(ExportPolicy.normalizedMime("image/png"));
    }

    @Test public void sizesHaveAnIndependentThreeMebibyteBoundary() {
        assertEquals(3 * 1024 * 1024, ReceiptPolicy.MAX_BYTES);
        assertTrue(ReceiptPolicy.permittedReportedSize(-1));
        assertTrue(ReceiptPolicy.permittedReportedSize(1));
        assertTrue(ReceiptPolicy.permittedReportedSize(ReceiptPolicy.MAX_BYTES));
        assertFalse(ReceiptPolicy.permittedReportedSize(0));
        assertFalse(ReceiptPolicy.permittedReportedSize(-2));
        assertFalse(ReceiptPolicy.permittedReportedSize(ReceiptPolicy.MAX_BYTES + 1L));
        assertFalse(ReceiptPolicy.permittedReportedSize(Long.MAX_VALUE));
        assertEquals(8 * 1024 * 1024, ExportPolicy.MAX_BYTES);
    }

    @Test public void chooserUrisCannotTargetFilesOwnProvidersOrAmbiguousAuthorities() {
        assertTrue(ReceiptPolicy.isExternalDocument("content://com.android.providers.media.documents/document/image%3A22", APP));
        assertTrue(ReceiptPolicy.isExternalDocument("content://com.android.externalstorage.documents/document/primary%3ADownloads%2Fbill.pdf", APP));
        String[] rejected = {"file:///data/user/0/" + APP + "/private", "https://example.com/bill.pdf", "content://" + APP + "/receipt",
                "content://" + APP + ".files/private", "content://COM.SMARTCONSTRUCTION.CRM.FILES/private",
                "content://0@com.provider/doc", "content://provider:443/doc", "content://provider/doc#fragment",
                "content:///doc", "content://provider", "content://provider\\other/doc", " content://provider/doc", null};
        for (String value : rejected) assertFalse(String.valueOf(value), ReceiptPolicy.isExternalDocument(value, APP));
    }

    @Test public void contentMustMatchItsAllowedDeclaredType() {
        byte[] jpeg = {(byte) 255, (byte) 216, (byte) 255, 0};
        byte[] png = {(byte) 137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1};
        byte[] webp = "RIFF0000WEBPpayload".getBytes(StandardCharsets.US_ASCII);
        byte[] pdf = "%PDF-1.7\n".getBytes(StandardCharsets.US_ASCII);
        assertTrue(ReceiptPolicy.matchesSignature(jpeg, "image/jpeg"));
        assertTrue(ReceiptPolicy.matchesSignature(png, "image/png"));
        assertTrue(ReceiptPolicy.matchesSignature(webp, "image/webp"));
        assertTrue(ReceiptPolicy.matchesSignature(pdf, "application/pdf"));
        assertFalse(ReceiptPolicy.matchesSignature(pdf, "image/png"));
        assertFalse(ReceiptPolicy.matchesSignature("<html>fake</html>".getBytes(StandardCharsets.US_ASCII), "application/pdf"));
        assertFalse(ReceiptPolicy.matchesSignature("<svg/>".getBytes(StandardCharsets.US_ASCII), "image/svg+xml"));
        assertFalse(ReceiptPolicy.matchesSignature(new byte[0], "image/jpeg"));
        assertFalse(ReceiptPolicy.matchesSignature(new byte[ReceiptPolicy.MAX_BYTES + 1], "image/jpeg"));
        assertFalse(ReceiptPolicy.matchesSignature(null, "application/pdf"));
    }

    @Test public void downloadedNamesHaveOnlyTheMatchingSafeExtension() {
        assertEquals("smart-construction-receipt.jpg", ReceiptPolicy.filename("image/jpeg"));
        assertEquals("smart-construction-receipt.png", ReceiptPolicy.filename("image/png"));
        assertEquals("smart-construction-receipt.webp", ReceiptPolicy.filename("image/webp"));
        assertEquals("smart-construction-receipt.pdf", ReceiptPolicy.filename("application/pdf"));
        assertThrows(IllegalArgumentException.class, () -> ReceiptPolicy.filename("text/html"));
    }
}
