package com.sidm.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class StringsTest {
    @Test fun bothLanguagesHaveEveryString() {
        val en = Strings.keys("en")
        val bn = Strings.keys("bn")
        assertEquals("missing in Bangla: ${en - bn}", emptySet<String>(), en - bn)
        assertEquals("missing in English: ${bn - en}", emptySet<String>(), bn - en)
    }

    @Test fun placeholdersMatch() {
        val ph = Regex("""\{\d}""")
        for (key in Strings.keys("en")) {
            val a = ph.findAll(Strings.get("en", key)).map { it.value }.toSet()
            val b = ph.findAll(Strings.get("bn", key)).map { it.value }.toSet()
            assertEquals("placeholders differ for $key", a, b)
        }
    }

    @Test fun errorCodesBecomeSentences() {
        assertTrue(Strings.error("en", "errAccess:403").contains("403"))
        assertEquals("plain text", Strings.error("en", "plain text"))
    }
}
