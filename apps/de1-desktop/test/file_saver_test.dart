import 'package:dub_desktop/mobile/file_saver.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('sanitizeFileName', () {
    test('keeps a normal Japanese name', () {
      expect(sanitizeFileName('運営名簿_20261127.csv'), '運営名簿_20261127.csv');
    });

    test('drops directories and unsafe characters', () {
      expect(sanitizeFileName('../../etc/passwd'), 'passwd');
      expect(sanitizeFileName(r'C:\tmp\a:b?.txt'), 'a_b_.txt');
    });

    test('falls back when empty', () {
      expect(sanitizeFileName(''), 'download');
      expect(sanitizeFileName(null), 'download');
      expect(sanitizeFileName('..'), 'download');
    });

    test('caps very long names but keeps the extension', () {
      final name = sanitizeFileName('${'a' * 300}.pdf');
      expect(name.length, 120);
      expect(name.endsWith('.pdf'), isTrue);
    });
  });

  group('fileNameFromContentDisposition', () {
    test('plain filename', () {
      expect(fileNameFromContentDisposition('attachment; filename="report.pdf"'),
          'report.pdf');
    });

    test('RFC 5987 filename* wins and is decoded', () {
      expect(
        fileNameFromContentDisposition(
            "attachment; filename=\"a.pdf\"; filename*=UTF-8''%E8%B3%87%E6%96%99.pdf"),
        '資料.pdf',
      );
    });

    test('missing header', () {
      expect(fileNameFromContentDisposition(null), isNull);
      expect(fileNameFromContentDisposition('inline'), isNull);
    });
  });
}
