package dev.conclave.client

import dev.conclave.client.logic.Canvas
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import java.io.IOException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** A live run's poll: it ends with the run, waits while the screen is hidden, and a failed read does not end it. */
@OptIn(ExperimentalCoroutinesApi::class)
class CanvasPollTest {
    @Test
    fun stopsWhenTheRunEnds() = runTest {
        var reads = 0
        val job = launch { Canvas.pollLive(2_000, { reads < 3 }, MutableStateFlow(1)) { reads++ } }
        advanceUntilIdle()
        assertEquals(3, reads)
        assertTrue(job.isCompleted)
    }

    @Test
    fun waitsWhileNobodyWatches() = runTest {
        var reads = 0
        val watched = MutableStateFlow(0)
        val job = launch { Canvas.pollLive(2_000, { true }, watched) { reads++ } }
        advanceTimeBy(60_000)
        runCurrent()
        assertEquals(0, reads)
        watched.value = 1
        runCurrent()
        assertEquals(1, reads)
        watched.value = 0
        advanceTimeBy(60_000)
        runCurrent()
        assertEquals(1, reads)
        job.cancel()
    }

    @Test
    fun aFailedReadKeepsPolling() = runTest {
        var reads = 0
        launch { Canvas.pollLive(2_000, { reads < 2 }, MutableStateFlow(1)) { reads++; throw IOException("offline") } }
        advanceUntilIdle()
        assertEquals(2, reads)
    }
}
