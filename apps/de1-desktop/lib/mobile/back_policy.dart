/// Pages the Android back button never returns to. The web app reaches `/`
/// from `/login` with `location.assign`, so without this the first back
/// after logging in shows the login form again while still logged in.
const Set<String> backSkipPaths = {'/login'};

/// How many steps to go back (a negative number for
/// `goBackOrForward(steps:)`), skipping [skipPaths] and entries for the page
/// already on screen. Null when there is nothing to go back to, so the app
/// should exit.
int? backSteps(List<Uri?> history, int currentIndex,
    {Set<String> skipPaths = backSkipPaths}) {
  final current = history[currentIndex]?.path;
  for (var i = currentIndex - 1; i >= 0; i--) {
    final path = history[i]?.path ?? '';
    if (skipPaths.contains(path) || path == current) continue;
    return i - currentIndex;
  }
  return null;
}
