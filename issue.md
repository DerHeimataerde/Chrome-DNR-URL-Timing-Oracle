#### VULNERABILITY DETAILS
It was discovered that Chrome extensions with only the `declarativeNetRequest` permission can leak the full URL of any tab without requiring the `tabs` permission or any host permissions.

The `declarativeNetRequest` API allows extensions to dynamically add blocking rules that match URLs using regular expressions. By exploiting the observable timing difference between blocked requests (which fail immediately with `net::ERR_BLOCKED_BY_CLIENT`) and allowed requests (which proceed to make network connections), an extension can perform a binary search to leak the URL character by character.

```cpp
// extensions/browser/api/web_request/extension_web_request_event_router.cc:1117-1127
case DNRRequestAction::Type::BLOCK:
  ClearPendingCallbacks(browser_context, *request);
  DCHECK_EQ(1u, actions.size());
  OnDNRActionMatched(browser_context, *request, action);
  return net::ERR_BLOCKED_BY_CLIENT;
```

The timing oracle is constructed using `chrome.tabs.reload` to trigger a navigation and `chrome.tabs.onUpdated.addListener` to detect when the page load completes (via the `status === "complete"` event).

By measuring the time between calling `reload` and receiving the completion event, the extension can determine whether the request was blocked or allowed.

##### The attack works as follows:
1. The extension creates a dynamic blocking rule with a regex pattern that matches a subset of possible characters at a specific position in the URL.
2. The extension calls `chrome.tabs.reload` and starts a timer.
3. The `chrome.tabs.onUpdated` listener waits for the `status === "complete"` event and calculates elapsed time.
4. If the URL matches the regex pattern, the request is blocked immediately (fast response ~10-30ms).
5. If the URL does not match, the request proceeds normally (slower response ~50-100ms+).
6. Using binary search over the character set, each character can be determined in few iterations.

I have also attached a video (`repro.mp4`) reproducing the issue.

#### IMPACT
The impact of this vulnerability is high. A malicious extension can silently extract sensitive information without user interaction or visible indicators. A non-exhaustive list of data that can be exfiltrated includes:
1. **OAuth tokens and authorization codes** - URLs like `https://example.com/callback?code=secret` expose tokens that can be used to hijack user accounts.
2. **Session tokens in query strings** - Many applications pass session identifiers or API keys in URLs.
3. **Private/unlisted content URLs** - Private YouTube videos, Google Drive files, Dropbox links, and other services that use URL-based access control can be leaked.
4. **Password reset tokens** - Reset links like `https://example.com/reset?token=secret` can be captured.
5. **Sensitive search queries** - Search terms, medical queries, financial information, and other private data in URLs.

Additionally, the attack can be made completely silent given the attacker can move the window to the background or minimize it while the exfiltration is happening, resulting in no visual indication that URLs are being leaked.

#### BISECT
An initial bisect narrowed the regression range to revisions 718858–718878 (https://chromium.googlesource.com/chromium/src/+log/baac8ed132e87c88164423e921b6b4a4352aae62..f440c12523cd84cb6f6c058d4671e103b7c71d27).

Further analysis indicates that regex rule evaluation was introduced in commit https://chromium.googlesource.com/chromium/src/+/1539dcc828ee3ba96c0949f1202cf9139b883d82, which enables the current PoC to work.

However, it is likely that a variant of this technique could be made to work prior to this change. I believe a modified version may be exploitable as far back as the introduction of the Dynamic Rules API itself (https://chromium-review.googlesource.com/c/chromium/src/+/1531023).

#### VERSION
Chrome Version: 144.0.7559.97 (Stable) \
Chrome Version: 145.0.7632.18 (Beta) \
Chrome Version: 146.0.7647.4 (Dev) \
Chrome Version: 146.0.7653.0 (Canary) \
Operating System: Windows 11 24H2

#### REPRODUCTION CASE
1. Open https://accounts.google.com/callback?code=secret in a new tab and move it to the first tab position.
2. Download `manifest.json` and `background.js`.
3. Place those files in the same directory and load the extension into Chrome.
4. Open the extension's service worker DevTools.
5. Observe the URL being leaked character by character in the console output.

#### CREDIT INFORMATION
Reporter credit: Luan Herrera (@lbherrera_)