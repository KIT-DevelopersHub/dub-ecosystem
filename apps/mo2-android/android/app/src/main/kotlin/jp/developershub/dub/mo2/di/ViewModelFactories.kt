// ViewModel factories — bridge the manual DI graph to Compose `viewModel()`.
// Each factory injects the container-owned dependencies into a ViewModel.
package jp.developershub.dub.mo2.di

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import jp.developershub.dub.mo2.core.network.MobileBffClient
import jp.developershub.dub.mo2.feature.home.HomeViewModel
import jp.developershub.dub.mo2.feature.tasks.TaskDetailViewModel
import jp.developershub.dub.mo2.feature.tasks.TaskRepository
import jp.developershub.dub.mo2.feature.tasks.TasksViewModel

class HomeViewModelFactory(
    private val client: MobileBffClient,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T =
        HomeViewModel(client) as T
}

class TasksViewModelFactory(
    private val repository: TaskRepository,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T =
        TasksViewModel(repository) as T
}

class TaskDetailViewModelFactory(
    private val taskId: String,
    private val client: MobileBffClient,
    private val repository: TaskRepository,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T =
        TaskDetailViewModel(taskId, client, repository) as T
}
