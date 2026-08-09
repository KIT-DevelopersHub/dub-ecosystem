// TasksViewModel unit tests (§7) — refresh -> content/empty/error, and the
// optimistic status change surfacing a 409 conflict effect while the list
// reflects the repository's rolled-back + refetched state.
package jp.developershub.dub.mo2.feature.tasks

import app.cash.turbine.test
import jp.developershub.dub.mo2.core.model.TaskStatus
import jp.developershub.dub.mo2.core.network.AppError
import jp.developershub.dub.mo2.core.network.AppErrorException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class TasksViewModelTest {

    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    @Test
    fun `refresh produces content with the server list`() = runTest {
        val fake = FakeMobileBffClient(myTasks = listOf(summary("a", TaskStatus.TODO)))
        val repo = TaskRepository(fake)
        val vm = TasksViewModel(repo)

        vm.refresh()

        val state = vm.uiState.value
        assertTrue(state is TasksUiState.Content)
        assertEquals(listOf("a"), (state as TasksUiState.Content).tasks.map { it.id })
        assertTrue(!state.isEmpty)
    }

    @Test
    fun `empty server list yields empty content`() = runTest {
        val vm = TasksViewModel(TaskRepository(FakeMobileBffClient(myTasks = emptyList())))
        vm.refresh()
        val state = vm.uiState.value
        assertTrue(state is TasksUiState.Content && state.isEmpty)
    }

    @Test
    fun `status change conflict emits a conflict effect`() = runTest {
        val fake = FakeMobileBffClient(
            myTasks = listOf(summary("t1", TaskStatus.TODO)),
            onUpdate = { _, _, _ -> throw AppErrorException(AppError.Conflict(serverVersion = 5)) },
            onGetTask = { id -> task(id, TaskStatus.IN_PROGRESS, version = 5) },
        )
        val repo = TaskRepository(fake)
        val vm = TasksViewModel(repo)
        vm.refresh()

        vm.effect.test {
            vm.changeStatus("t1", TaskStatus.DONE, baseVersion = 1)
            val effect = awaitItem()
            assertTrue(effect is TaskEffect.Conflict)
            assertEquals(5, (effect as TaskEffect.Conflict).serverVersion)
            cancelAndIgnoreRemainingEvents()
        }
        // list reflects the refetched server truth after rollback
        val state = vm.uiState.value as TasksUiState.Content
        assertEquals(TaskStatus.IN_PROGRESS, state.tasks.single().status)
    }
}
