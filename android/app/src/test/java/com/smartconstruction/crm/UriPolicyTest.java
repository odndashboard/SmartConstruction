package com.smartconstruction.crm;

import org.junit.Test;
import static org.junit.Assert.*;

public final class UriPolicyTest {
    @Test public void exactHttpsOriginAndDefaultPortAreInternal() {
        assertTrue(UriPolicy.isInternal(UriPolicy.HOME));
        assertTrue(UriPolicy.isInternal(UriPolicy.ORIGIN + ":443/login"));
        assertTrue(UriPolicy.isInternal("HTTPS://SMART-CONSTRUCTION-DASHBOARD.VERCEL.APP/auth/confirm#token_hash=private&type=recovery"));
    }

    @Test public void authorityAndSchemeConfusionNeverEntersTheApp() {
        String[] rejected = {
            "http://" + UriPolicy.HOST,
            "https://" + UriPolicy.HOST + ".evil.example/",
            "https://evil.example@" + UriPolicy.HOST + "/",
            "https://" + UriPolicy.HOST + "@evil.example/",
            "https://" + UriPolicy.HOST + ":444/",
            "https://" + UriPolicy.HOST + ":0/",
            "https://" + UriPolicy.HOST + "./",
            "https://" + UriPolicy.HOST + "\\@evil.example/",
            "https://%73mart-construction-dashboard.vercel.app/",
            "file:///etc/passwd", "content://private/data", "javascript:alert(1)",
            "intent://example/#Intent;scheme=https;end", "data:text/html,test",
            "//" + UriPolicy.HOST, " " + UriPolicy.HOME, UriPolicy.HOME + "\n", null
        };
        for (String value : rejected) assertFalse(String.valueOf(value), UriPolicy.isInternal(value));
    }

    @Test public void incomingLinksOnlyAcceptTheExactConfirmationPath() {
        assertTrue(UriPolicy.isAuthLink(UriPolicy.ORIGIN + "/auth/confirm#token_hash=test&type=invite"));
        assertFalse(UriPolicy.isAuthLink(UriPolicy.ORIGIN + "/login"));
        assertFalse(UriPolicy.isAuthLink(UriPolicy.ORIGIN + "/auth/confirm/extra"));
        assertFalse(UriPolicy.isAuthLink(UriPolicy.ORIGIN + "/auth/%63onfirm"));
        assertFalse(UriPolicy.isAuthLink("https://other.example/auth/confirm"));
    }

    @Test public void bridgeOriginCannotContainCredentialsPathsQueriesOrFragments() {
        assertTrue(UriPolicy.isExactOrigin(UriPolicy.ORIGIN));
        assertTrue(UriPolicy.isExactOrigin(UriPolicy.HOME));
        assertTrue(UriPolicy.isExactOrigin(UriPolicy.ORIGIN + ":443"));
        assertFalse(UriPolicy.isExactOrigin(UriPolicy.ORIGIN + "/login"));
        assertFalse(UriPolicy.isExactOrigin(UriPolicy.ORIGIN + "?token=test"));
        assertFalse(UriPolicy.isExactOrigin(UriPolicy.ORIGIN + "#token=test"));
        assertFalse(UriPolicy.isExactOrigin("https://user@" + UriPolicy.HOST));
        assertFalse(UriPolicy.isExactOrigin("null"));
    }

    @Test public void nativeDownloadIsBoundToTheWorkspaceExport() {
        assertTrue(UriPolicy.isWorkspaceExport(UriPolicy.ORIGIN + "/api/export"));
        assertFalse(UriPolicy.isWorkspaceExport(UriPolicy.ORIGIN + "/api/export?redirect=elsewhere"));
        assertFalse(UriPolicy.isWorkspaceExport(UriPolicy.ORIGIN + "/api/export#fragment"));
        assertFalse(UriPolicy.isWorkspaceExport(UriPolicy.ORIGIN + "/api/export/"));
        assertFalse(UriPolicy.isWorkspaceExport("https://other.example/api/export"));
    }

    @Test public void receiptDownloadAllowsOnlyOneExactSameOriginUuidEndpoint() {
        String path = "/api/expense-receipts/08ea7f0c-b4a6-44ae-95a1-fd8598df3378";
        assertTrue(UriPolicy.isExpenseReceipt(UriPolicy.ORIGIN + path));
        assertTrue(UriPolicy.isExpenseReceipt(UriPolicy.ORIGIN + ":443" + path));
        String[] rejected = {"https://other.example" + path, "http://" + UriPolicy.HOST + path,
                UriPolicy.ORIGIN + path + "?download=true", UriPolicy.ORIGIN + path + "#fragment",
                UriPolicy.ORIGIN + path + "/", UriPolicy.ORIGIN + path + "/other",
                UriPolicy.ORIGIN + "/api/expense-receipts/not-a-uuid",
                UriPolicy.ORIGIN + "/api/expense-receipts/", UriPolicy.ORIGIN + "/api/%65xpense-receipts/08ea7f0c-b4a6-44ae-95a1-fd8598df3378",
                "https://user@" + UriPolicy.HOST + path, UriPolicy.ORIGIN + ":444" + path};
        for (String value : rejected) assertFalse(value, UriPolicy.isExpenseReceipt(value));
    }

    @Test public void externalLinksRequireUserGestureAndSupportedSchemes() {
        assertTrue(UriPolicy.mayOpenExternal("https://example.com/document", true));
        assertTrue(UriPolicy.mayOpenExternal("tel:+919876543210", true));
        assertTrue(UriPolicy.mayOpenExternal("mailto:employee@example.com", true));
        assertFalse(UriPolicy.mayOpenExternal("https://example.com/document", false));
        assertFalse(UriPolicy.mayOpenExternal(UriPolicy.HOME, true));
        assertFalse(UriPolicy.mayOpenExternal("https://user:pass@example.com/", true));
        assertFalse(UriPolicy.mayOpenExternal("http://example.com/", true));
        assertFalse(UriPolicy.mayOpenExternal("intent://example", true));
        assertFalse(UriPolicy.mayOpenExternal("file:///private", true));
        assertFalse(UriPolicy.mayOpenExternal("mailto:name@example.com?subject=hello%0aInjected", true));
    }

    @Test public void thirdPartyResourceExceptionsAreOnlyStaticFontsOverHttpsGet() {
        assertTrue(UriPolicy.isAllowedResource(UriPolicy.ORIGIN + "/api/workspace", "POST"));
        assertTrue(UriPolicy.isAllowedResource("https://fonts.googleapis.com/css2?family=DM+Sans", "GET"));
        assertTrue(UriPolicy.isAllowedResource("https://fonts.gstatic.com/s/dmsans/font.woff2", "GET"));
        assertFalse(UriPolicy.isAllowedResource("https://fonts.googleapis.com/css2", "POST"));
        assertFalse(UriPolicy.isAllowedResource("http://fonts.googleapis.com/css2", "GET"));
        assertFalse(UriPolicy.isAllowedResource("https://fonts.googleapis.com.evil.example/css2", "GET"));
        assertFalse(UriPolicy.isAllowedResource("https://fonts.gstatic.com/script.js", "GET"));
        assertFalse(UriPolicy.isAllowedResource("https://fonts.googleapis.com:444/css2", "GET"));
    }
}
