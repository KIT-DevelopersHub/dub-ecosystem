// DubNavHost — the app shell navigation graph. Consumes the SAME route table as
// parseDeepLink: destinations declare navDeepLink patterns for App Links
// (https://developershub.jp/...) and the dub:// fallback, and an externally
// resolved Route (e.g. from a push tap) maps to a nav route via toNavRoute().
// Home (S2), Tasks list (S5) + Task detail (S6), Inbox (S7), Event detail (S4).
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
import jp.developershub.dub.mo2.di.HomeViewModelFactory
import jp.developershub.dub.mo2.di.TaskDetailViewModelFactory
import jp.developershub.dub.mo2.feature.home.HomeEvent
import jp.developershub.dub.mo2.feature.home.HomeScreen
import jp.developershub.dub.mo2.feature.home.HomeViewModel
import jp.developershub.dub.mo2.feature.tasks.TaskDetailScreen
import jp.developershub.dub.mo2.feature.tasks.TaskDetailUiState
import jp.developershub.dub.mo2.feature.tasks.TaskDetailViewModel
import jp.developershub.dub.mo2.feature.tasks.TaskEffect

object NavRoutes {
    const val HOME = "home"
    const val INBOX = "inbox"
    const val TASK_DETAIL = "task/{taskId}"
    const val EVENT_DETAIL = "event/{eventId}"
    fun taskDetail(taskId: String) = "task/$taskId"
    fun eventDetail(eventId: String) = "event/$eventId"
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
                HomeScreen(state = state, modifier = Modifier.padding(padding))
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
                    is TaskDetailUiState.Loading -> Text("Loading…", Modifier.padding(padding))
                    is TaskDetailUiState.Error -> Text("Couldn't load task", Modifier.padding(padding))
                    is TaskDetailUiState.Content -> TaskDetailScreen(
                        title = s.task.title,
                        status = s.task.status,
                        version = s.task.version,
                        onChangeStatus = { next, ver -> vm.changeStatus(next, ver) },
                        modifier = Modifier.padding(padding),
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
                // S7 inbox screen lands in the notification wave.
                Text("Inbox (S7) — coming in the notification wave", Modifier.padding(padding))
            }

            composable(
                route = NavRoutes.EVENT_DETAIL,
                deepLinks = listOf(
                    navDeepLink { uriPattern = "$HTTPS/events/{eventId}" },
                    navDeepLink { uriPattern = "${MoConfig.DEEP_LINK_SCHEME}://events/{eventId}" },
                ),
            ) { backStackEntry ->
                val eventId = backStackEntry.arguments?.getString("eventId").orEmpty()
                // S4 event overview screen lands in a later wave.
                Text("Event $eventId (S4) — coming soon", Modifier.padding(padding))
            }
        }
    }
}
