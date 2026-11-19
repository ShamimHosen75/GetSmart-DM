package com.sidm.core

/**
 * One shared speed limit for every download (a token bucket).
 * [bytesPerSecond] 0 means no limit. Safe to call from many threads.
 */
class SpeedLimiter(
    bytesPerSecond: Long = 0,
    private val clock: () -> Long = System::nanoTime,
    private val sleeper: (Long) -> Unit = { ms -> Thread.sleep(ms) },
) {
    @Volatile
    var bytesPerSecond: Long = bytesPerSecond
        set(value) {
            field = value.coerceAtLeast(0)
        }

    private val lock = Object()
    private var tokens = 0.0
    private var last = clock()

    /** Blocks until [bytes] may be used under the current limit. */
    fun acquire(bytes: Int) {
        if (bytes <= 0) return
        while (true) {
            val rate = bytesPerSecond
            if (rate <= 0) return
            val waitMs: Long
            synchronized(lock) {
                val now = clock()
                tokens = minOf(rate.toDouble(), tokens + (now - last) / 1e9 * rate)
                last = now
                if (tokens >= bytes || (tokens >= 0 && bytes > rate)) {
                    // A read bigger than one second's worth is let through and paid back below zero.
                    tokens -= bytes
                    return
                }
                waitMs = (((bytes - tokens) / rate) * 1000).toLong().coerceIn(1, 1000)
            }
            sleeper(waitMs)
        }
    }
}
