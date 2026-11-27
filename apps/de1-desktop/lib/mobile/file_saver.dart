import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/widgets.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:http/http.dart' as http;
import 'package:share_plus/share_plus.dart';

/// Makes a server- or page-supplied name safe to use as a file name.
String sanitizeFileName(String? raw, {String fallback = 'download'}) {
  var name = (raw ?? '').trim();
  name = name.split(RegExp(r'[\\/]')).last;
  name = name.replaceAll(RegExp(r'[\x00-\x1f:*?"<>|]'), '_');
  if (name.isEmpty || name == '.' || name == '..') return fallback;
  return name.length > 120 ? name.substring(name.length - 120) : name;
}

/// File name from a `Content-Disposition` header (`filename*=` wins).
String? fileNameFromContentDisposition(String? header) {
  if (header == null) return null;
  final star = RegExp(r"filename\*\s*=\s*([^']*)'[^']*'([^;]+)", caseSensitive: false)
      .firstMatch(header);
  if (star != null) {
    try {
      return Uri.decodeComponent(star.group(2)!.trim());
    } catch (_) {}
  }
  final plain = RegExp(r'filename\s*=\s*"?([^";]+)"?', caseSensitive: false)
      .firstMatch(header);
  return plain?.group(1)?.trim();
}

/// Hands a file to the OS share sheet, where the person can "Save to Files",
/// open it in another app, AirDrop it, etc.
class FileSaver {
  const FileSaver();

  /// JS bridge entry: `(name, mime, base64)` from [DownloadBridge].
  Future<void> saveBase64(
    BuildContext context, {
    required String name,
    required String mime,
    required String base64Data,
  }) {
    return saveBytes(
      context,
      name: name,
      mime: mime,
      bytes: base64Decode(base64Data),
    );
  }

  Future<void> saveBytes(
    BuildContext context, {
    required String name,
    required String mime,
    required Uint8List bytes,
  }) async {
    final fileName = sanitizeFileName(name);
    await Share.shareXFiles(
      [XFile.fromData(bytes, name: fileName, mimeType: mime)],
      fileNameOverrides: [fileName],
      sharePositionOrigin: _origin(context),
    );
  }

  /// A server response the WebView wanted to download (Content-Disposition:
  /// attachment). Only called for Dub hosts, so sending the session cookie is
  /// safe.
  Future<void> downloadUrl(
    BuildContext context,
    DownloadStartRequest request,
  ) async {
    final url = request.url;
    final cookies = await CookieManager.instance().getCookies(url: url);
    final headers = <String, String>{
      if (cookies.isNotEmpty)
        'cookie': cookies.map((c) => '${c.name}=${c.value}').join('; '),
      if (request.userAgent != null) 'user-agent': request.userAgent!,
    };
    final res = await http.get(url, headers: headers);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw http.ClientException('HTTP ${res.statusCode}', url);
    }
    if (!context.mounted) return;
    final name = request.suggestedFilename ??
        fileNameFromContentDisposition(
          request.contentDisposition ?? res.headers['content-disposition'],
        ) ??
        (url.pathSegments.isEmpty ? null : url.pathSegments.last);
    await saveBytes(
      context,
      name: name ?? 'download',
      mime: request.mimeType ??
          res.headers['content-type'] ??
          'application/octet-stream',
      bytes: res.bodyBytes,
    );
  }

  /// iPad presents the share sheet as a popover and needs an anchor.
  Rect _origin(BuildContext context) {
    final box = context.findRenderObject() as RenderBox?;
    if (box == null || !box.hasSize) return const Rect.fromLTWH(0, 0, 1, 1);
    final center = box.localToGlobal(box.size.center(Offset.zero));
    return Rect.fromCenter(center: center, width: 1, height: 1);
  }
}
