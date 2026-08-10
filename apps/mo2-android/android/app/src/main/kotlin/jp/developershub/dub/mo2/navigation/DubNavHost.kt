// DubNavHost — the app shell navigation graph. Consumes the SAME route table as
// parseDeepLink: home/inbox/events/{id}/tasks/{id} declare navDeepLink patterns for
// App Links (https://developershub.jp/...) and the dub:// fallback, and an
// externally resolved Route (e.g. from a push tap) maps to a nav route via
// toNavRoute(). Internal-only destinations (events list, gantt, chat, preferences,
// devices) are navigated in-app and carry no deep link. Screens S2–S11 + settings.
package jp.developershub.dub.mo2.navigation

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navDeepLink
import jp.developershub.dub.mo2.core.common.MoConfig
import jp.developershub.dub.mo2.di.AppContainer
import jp.developershub.dub.mo2.di.ChannelListViewModelFactory
import jp.developershub.dub.mo2.di.ChatViewModelFactory
import jp.developershub.dub.mo2.di.DevicesViewModelFactory
import jp.developershub.dub.mo2.di.EventDetailViewModelFactory
import jp.developershub.dub.mo2.di.EventsViewModelFactory
import jp.developershub.dub.mo2.di.GanttViewModelFactory
import jp.developershub.dub.mo2.di.HomeViewModelFactory
import jp.developershub.dub.mo2.di.InboxViewModelFactory
import jp.developershub.dub.mo2.di.PreferencesViewModelFactory
import jp.developershub.dub.mo2.di.TaskDetailViewModelFactory
import jp.developershub.dub.mo2.feature.chat.ChannelListScreen
import jp.developershub.dub.mo2.feature.chat.ChannelListViewModel
import jp.developershub.dub.mo2.feature.chat.ChatScreen
import jp.developershub.dub.mo2.feature.chat.ChatViewModel
import jp.developershub.dub.mo2.feature.devices.DevicesEffect
import jp.developershub.dub.mo2.feature.devices.DevicesScreen
import jp.developershub.dub.mo2.feature.devices.DevicesViewModel
import jp.developershub.dub.mo2.feature.events.EventDetailScreen
import jp.developershub.dub.mo2.feature.events.EventDetailViewModel
import jp.developershub.dub.mo2.feature.events.EventsScreen
import jp.developershub.dub.mo2.feature.events.EventsViewModel
import jp.developershub.dub.mo2.feature.gantt.GanttScreen
import jp.developershub.dub.mo2.feature.gantt.GanttViewModel
import jp.developershub.dub.mo2.feature.home.HomeEvent
import jp.developershub.dub.mo2.feature.home.HomeScreen
import jp.developershub.dub.mo2.feature.home.HomeViewModel
import jp.developershub.dub.mo2.feature.inbox.InboxScreen
import jp.developershub.dub.mo2.feature.inbox.InboxViewModel
import jp.developershub.dub.mo2.feature.preferences.PreferencesScreen
import jp.developershub.dub.mo2.feature.preferences.PreferencesViewModel
import jp.developershub.dub.mo2.feature.tasks.TaskDetailScreen
import jp.developershub.dub.mo2.feature.tasks.TaskDetailUiState
import jp.developershub.dub.mo2.feature.tasks.TaskDetailViewModel
import jp.developershub.dub.mo2.feature.tasks.TaskEffect

object NavRoutes {
    const val HOME = "home"
    const val INBOX = "inbox"
    const val EVENTS = "events"
    const val PREFERENCES = "preferences"
    const val DEVICES = "devices"
    const val CHANNELS = "chat"
    const val TASK_DETAIL = "task/{taskId}"
    const val EVENT_DETAIL = "event/{eventId}"
    const val GANTT = "gantt/{eventId}"
    const val CHAT_THREAD = "chat/{channelId}"
    fun taskDetail(taskId: String) = "task/$taskId"
    fun eventDetail(eventId: String) = "event/$eventId"
    fun gantt(eventId: String) = "gantt/$eventId"
    fun chatThread(channelId: String) = "chat/$channelId"
}

/** Map a resolved deep-link Route (push tap / external intent) to a nav route. */
fun Route.toNavRoute(): String = when (this) {
    is Route.Home -> NavRoutes.HOME
    is Route.Inbox -> NavRoutes.INBOX
    is Route.TaskDetail -> NavRoutes.taskDetail(taskId)
    is Route.EventDetail -> NavRoutes.eventDetail(eventId)
    is Route.Unknown -> NavRoutes.HOME
}

private const val HTTPS = "https://developershub.jp"

@Composable
fun DubNavHost(
    container: AppContainer,
    navController: NavHostController = rememberNavController(),
    modifier: Modifier = Modifier,
) {
    val snackbar = remember { SnackbarHostState() }

    Scaffold(
        modifier = modifier,
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        val content = Modifier.padding(padding)
        NavHost(
            navController = navController,
            startDestination = NavRoutes.HOME,
            modifier = Modifier,
        ) {
            composable(
                route = NavRoutes.HOME,
                deepLinks = listOf(
                    navDeepLink { uriPattern = "$HTTPS/home" },
                    navDeepLink { uriPattern = "${MoConfig.DEEP_LINK_SCHEME}://home" },
                ),
            ) {
                val vm: HomeViewModel = viewModel(factory = HomeViewModelFactory(container.bffClient))
                LaunchedEffect(Unit) { vm.onEvent(HomeEvent.Load) }
                val state by vm.uiState.collectAsStateWithLifecycle()
                HomeScreen(state = state, modifier = content)
            }

            composable(
                route = NavRoutes.TASK_DETAIL,
                deepLinks = listOf(
                    navDeepLink { uriPattern = "$HTTPS/tasks/{taskId}" },
                    navDeepLink { uriPattern = "${MoConfig.DEEP_LINK_SCHEME}://tasks/{taskId}" },
                ),
            ) { backStackEntry ->
                val taskId = backStackEntry.arguments?.getString("taskId").orEmpty()
                val vm: TaskDetailViewModel = viewModel(
                    factory = TaskDetailViewModelFactory(taskId, container.bffClient, container.taskRepository),
                )
                LaunchedEffect(taskId) { vm.load() }
                LaunchedEffect(vm) {
                    vm.effect.collect { eff ->
                        val msg = when (eff) {
                            is TaskEffect.Conflict -> "Task changed on the server — refreshed"
                            is TaskEffect.Failure -> "Couldn't update task"
                        }
                        snackbar.showSnackbar(msg)
                    }
                }
                when (val s = vm.uiState.collectAsStateWithLifecycle().value) {
                    is TaskDetailUiState.Loading -> Text("Loading…", content)
                    is TaskDetailUiState.Error -> Text("Couldn't load task", content)
                    is TaskDetailUiState.Content -> TaskDetailScreen(
                        title = s.task.title,
                        status = s.task.status,
                        version = s.task.version,
                        onChangeStatus = { next, ver -> vm.changeStatus(next, ver) },
                        modifier = content,
                    )
                }
            }

            composable(
                route = NavRoutes.INBOX,
                deepLinks = listOf(
                    navDeepLink { uriPattern = "$HTTPS/inbox" },
                    navDeepLink { uriPattern = "${MoConfig.DEEP_LINK_SCHEME}://inbox" },
                ),
            ) {
                val vm: InboxViewModel = viewModel(factory = InboxViewModelFactory(container.bffClient))
                LaunchedEffect(Unit) { vm.load() }
                val state by vm.uiState.collectAsStateWithLifecycle()
                InboxScreen(
                    state = state,
                    onMarkRead = vm::markRead,
                    onMarkAllRead = vm::markAllRead,
                    modifier = content,
                )
            }

            composable(
                route = NavRoutes.EVENT_DETAIL,
                deepLinks = listOf(
                    navDeepLink { uriPattern = "$HTTPS/events/{eventId}" },
                    navDeepLink { uriPattern = "${MoConfig.DEEP_LINK_SCHEME}://events/{eventId}" },
                ),
            ) { backStackEntry ->
                val eventId = backStackEntry.arguments?.getString("eventId").orEmpty()
                val vm: EventDetailViewModel =
                    viewModel(factory = EventDetailViewModelFactory(container.bffClient, eventId))
                LaunchedEffect(eventId) { vm.load() }
                val state by vm.uiState.collectAsStateWithLifecycle()
                EventDetailScreen(state = state, modifier = content)
            }

            composable(NavRoutes.EVENTS) {
                val vm: EventsViewModel = viewModel(factory = EventsViewModelFactory(container.bffClient))
                LaunchedEffect(Unit) { vm.load() }
                val state by vm.uiState.collectAsStateWithLifecycle()
                EventsScreen(
                    state = state,
                    onEventClick = { navController.navigate(NavRoutes.eventDetail(it)) },
                    modifier = content,
                )
            }

            composable(NavRoutes.GANTT) { backStackEntry ->
                val eventId = backStackEntry.arguments?.getString("eventId").orEmpty()
                val vm: GanttViewModel = viewModel(factory = GanttViewModelFactory(container.bffClient, eventId))
                LaunchedEffect(eventId) { vm.onEvent(jp.developershub.dub.mo2.feature.gantt.GanttEvent.Load) }
                val state by vm.uiState.collectAsStateWithLifecycle()
                GanttScreen(state = state, onEvent = vm::onEvent, modifier = content)
            }

            composable(NavRoutes.CHANNELS) {
                val vm: ChannelListViewModel =
                    viewModel(factory = ChannelListViewModelFactory(container.chatRepository))
                LaunchedEffect(Unit) { vm.load() }
                val state by vm.uiState.collectAsStateWithLifecycle()
                ChannelListScreen(
                    state = state,
                    onChannelClick = { navController.navigate(NavRoutes.chatThread(it)) },
                    modifier = content,
                )
            }

            composable(NavRoutes.CHAT_THREAD) { backStackEntry ->
                val channelId = backStackEntry.arguments?.getString("channelId").orEmpty()
                val vm: ChatViewModel = viewModel(
                    factory = ChatViewModelFactory(container.chatRepository, channelId, container.currentUserId),
                )
                LaunchedEffect(channelId) { vm.load() }
                val state by vm.uiState.collectAsStateWithLifecycle()
                ChatScreen(state = state, onSend = vm::send, modifier = content)
            }

            composable(NavRoutes.PREFERENCES) {
                val vm: PreferencesViewModel =
                    viewModel(factory = PreferencesViewModelFactory(container.bffClient))
                LaunchedEffect(Unit) { vm.load() }
                val state by vm.uiState.collectAsStateWithLifecycle()
                PreferencesScreen(state = state, onToggle = vm::toggleChannel, modifier = content)
            }

            composable(NavRoutes.DEVICES) {
                val vm: DevicesViewModel = viewModel(factory = DevicesViewModelFactory(container.bffClient))
                LaunchedEffect(Unit) { vm.load() }
                LaunchedEffect(vm) {
                    vm.effect.collect { eff ->
                        when (eff) {
                            is DevicesEffect.RevokeFailed -> snackbar.showSnackbar("Couldn't revoke device")
                        }
                    }
                }
                val state by vm.uiState.collectAsStateWithLifecycle()
                DevicesScreen(state = state, onRevoke = vm::revoke, modifier = content)
            }
        }
    }
}
