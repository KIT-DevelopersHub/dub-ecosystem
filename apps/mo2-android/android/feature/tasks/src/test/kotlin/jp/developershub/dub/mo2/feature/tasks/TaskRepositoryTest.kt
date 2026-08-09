// TaskRepository unit tests (§7) — optimistic status change: commit on 200,
// rollback + refetch on 409, rollback on other error, and the not-in-cache guard.
// Mirrors task-repository.test.ts.
package jp.developershub.dub.mo2.feature.tasks

import jp.developershub.dub.mo2.core.model.TaskStatus
import jp.developershub.dub.mo2.core.network.AppError
import jp.developershub.dub.mo2.core.network.AppErrorException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TaskRepositoryTest {

    @Test
    fun `commits authoritative server state on success`() = runTest {
        val fake = FakeMobileBffClient(
            onUpdate = { id, status, _ -> task(id, status, version = 2) },
        )
        val repo = TaskRepository(fake)
        repo.seed(listOf(summary("t1", TaskStatus.TODO)))

        val result = repo.updateStatus("t1", TaskStatus.DONE, baseVersion = 1)

        assertTrue(result is TaskUpdateResult.Ok)
        assertEquals(TaskStatus.DONE, repo.tasks.value.single().status)
        assertEquals(1, fake.updateCalls)
    }

    @Test
    fun `rolls back and refetches on 409 conflict`() = runTest {
        val fake = FakeMobileBffClient(
            onUpdate = { _, _, _ -> throw AppErrorException(AppError.Conflict(serverVersion = 7)) },
            onGetTask = { id -> task(id, TaskStatus.IN_PROGRESS, version = 7) },
        )
        val repo = TaskRepository(fake)
        repo.seed(listOf(summary("t1", TaskStatus.TODO)))

        val result = repo.updateStatus("t1", TaskStatus.DONE, baseVersion = 1)

        assertTrue(result is TaskUpdateResult.Conflict)
        assertEquals(7, (result as TaskUpdateResult.Conflict).serverVersion)
        // rolled back off the optimistic DONE, then refetched to server truth
        assertEquals(TaskStatus.IN_PROGRESS, repo.tasks.value.single().status)
        assertEquals(1, fake.getTaskCalls)
    }

    @Test
    fun `rolls back to previous on non-conflict error`() = runTest {
        val fake = FakeMobileBffClient(
            onUpdate = { _, _, _ -> throw AppErrorException(AppError.Network(retryable = true)) },
        )
        val repo = TaskRepository(fake)
        repo.seed(listOf(summary("t1", TaskStatus.TODO)))

        val result = repo.updateStatus("t1", TaskStatus.DONE, baseVersion = 1)

        assertTrue(result is TaskUpdateResult.Failure)
        assertEquals(TaskStatus.TODO, repo.tasks.value.single().status)
        assertEquals(0, fake.getTaskCalls)
    }

    @Test
    fun `keeps rolled-back value when conflict refetch also fails`() = runTest {
        val fake = FakeMobileBffClient(
            onUpdate = { _, _, _ -> throw AppErrorException(AppError.Conflict(serverVersion = null)) },
            onGetTask = { throw AppErrorException(AppError.Network(retryable = true)) },
        )
        val repo = TaskRepository(fake)
        repo.seed(listOf(summary("t1", TaskStatus.TODO)))

        val result = repo.updateStatus("t1", TaskStatus.DONE, baseVersion = 1)

        assertTrue(result is TaskUpdateResult.Conflict)
        assertEquals(TaskStatus.TODO, repo.tasks.value.single().status)
    }

    @Test
    fun `returns failure when task is not in cache`() = runTest {
        val repo = TaskRepository(FakeMobileBffClient())
        val result = repo.updateStatus("ghost", TaskStatus.DONE, baseVersion = 1)
        assertTrue(result is TaskUpdateResult.Failure)
        assertTrue((result as TaskUpdateResult.Failure).error is AppError.Server)
    }

    @Test
    fun `refreshMyTasks replaces cache from server`() = runTest {
        val fake = FakeMobileBffClient(myTasks = listOf(summary("a", TaskStatus.TODO), summary("b", TaskStatus.DONE)))
        val repo = TaskRepository(fake)
        repo.refreshMyTasks()
        assertEquals(listOf("a", "b"), repo.tasks.value.map { it.id })
    }
}
