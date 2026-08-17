import 'package:test/test.dart';
import 'package:dub_api_client/dub_api_client.dart';


/// tests for GatewayApi
void main() {
  final instance = DubApiClient().getGatewayApi();

  group(GatewayApi, () {
    // Submit a public contact inquiry
    //
    // Unauthenticated public endpoint. Protected by Cloudflare Turnstile (turnstileToken) and IP rate limiting.
    //
    //Future<PublicInquiryResponse> createPublicInquiry(PublicInquiryRequest publicInquiryRequest) async
    test('test createPublicInquiry', () async {
      // TODO
    });

    // Home screen aggregate (events + unread)
    //
    // Gateway-owned BFF composition across event + notification. Degraded upstreams surface in partialErrors rather than failing the whole response.
    //
    //Future<BffHomeResponse> getBffHome() async
    test('test getBffHome', () async {
      // TODO
    });

    // Current user, org, permissions and session expiry
    //
    // Gateway-owned composition (identity + session). Requires an authenticated session.
    //
    //Future<MeResponse> getMe() async
    test('test getMe', () async {
      // TODO
    });

  });
}
