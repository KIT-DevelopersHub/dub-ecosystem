// ViewModel factories — bridge the manual DI graph to Compose `viewModel()`.
// Each factory injects the container-owned dependencies into a ViewModel.
package jp.developershub.dub.mo2.di

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import jp.developershub.dub.mo2.core.network.MobileBffClient
import jp.developershub.dub.mo2.feature.chat.ChannelListViewModel
import jp.developershub.dub.mo2.feature.chat.ChatRepository
import jp.developershub.dub.mo2.feature.chat.ChatViewModel
import jp.developershub.dub.mo2.feature.devices.DevicesViewModel
import jp.developershub.dub.mo2.feature.events.EventDetailViewModel
import jp.developershub.dub.mo2.feature.events.EventsViewModel
import jp.developershub.dub.mo2.feature.gantt.GanttViewModel
import jp.developershub.dub.mo2.feature.home.HomeViewModel
import jp.developershub.dub.mo2.feature.inbox.InboxViewModel
import jp.developershub.dub.mo2.feature.preferences.PreferencesViewModel
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

class EventsViewModelFactory(
    private val client: MobileBffClient,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = EventsViewModel(client) as T
}

class EventDetailViewModelFactory(
    private val client: MobileBffClient,
    private val eventId: String,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = EventDetailViewModel(client, eventId) as T
}

class GanttViewModelFactory(
    private val client: MobileBffClient,
    private val eventId: String,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = GanttViewModel(client, eventId) as T
}

class ChannelListViewModelFactory(
    private val repository: ChatRepository,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = ChannelListViewModel(repository) as T
}

class ChatViewModelFactory(
    private val repository: ChatRepository,
    private val channelId: String,
    private val currentUserId: String,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T =
        ChatViewModel(repository, channelId, currentUserId) as T
}

class InboxViewModelFactory(
    private val client: MobileBffClient,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = InboxViewModel(client) as T
}

class PreferencesViewModelFactory(
    private val client: MobileBffClient,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = PreferencesViewModel(client) as T
}

class DevicesViewModelFactory(
    private val client: MobileBffClient,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = DevicesViewModel(client) as T
}
