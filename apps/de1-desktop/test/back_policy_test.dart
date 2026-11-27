import 'package:dub_desktop/mobile/back_policy.dart';
import 'package:flutter_test/flutter_test.dart';

Uri u(String path) => Uri.parse('https://dub.example$path');

void main() {
  test('goes back one page normally', () {
    expect(backSteps([u('/'), u('/members')], 1), -1);
  });

  test('skips /login after logging in', () {
    expect(backSteps([u('/'), u('/login'), u('/')], 2), -2);
  });

  test('exits when only /login is behind', () {
    expect(backSteps([u('/login'), u('/')], 1), isNull);
  });

  test('exits at the first page', () {
    expect(backSteps([u('/')], 0), isNull);
  });

  test('a missing url counts as a page', () {
    expect(backSteps([null, u('/')], 1), -1);
  });
}
