#include <errno.h>
#include <json.h>
#include <libwebsockets.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#include <zlib.h>

#include "html.h"
#include "server.h"
#include "utils.h"

enum { AUTH_OK, AUTH_FAIL, AUTH_ERROR };

// Cap on an accepted paste. Screenshots are far below this; the limit exists
// because the handler sits on the same port as the terminal.
#define MAX_IMAGE_BYTES (12 * 1024 * 1024)

// Cap on a stored tab layout. A few hundred tabs still fit comfortably; the
// point is that an unauthenticated-looking POST can't grow a file forever.
#define MAX_TABS_BYTES (1024 * 1024)

// Name of the cookie a successful basic-auth hands back, and the size of the
// random token inside it. 32 bytes is far past guessing range, and the hex
// form keeps the cookie printable.
#define AUTH_COOKIE "ttyd_session"
#define SESSION_TOKEN_BYTES 32
#define SESSION_TOKEN_HEX (SESSION_TOKEN_BYTES * 2)

// How many logins stay valid at once. One per browser that has ever signed in
// and not expired — a phone, a laptop, a few private windows. Past this the
// oldest is dropped rather than growing the file without bound.
#define MAX_SESSIONS 32

static char *html_cache = NULL;
static size_t html_cache_len = 0;

static bool accept_gzip(struct lws *wsi) {
  char buf[256];
  int len = lws_hdr_copy(wsi, buf, sizeof(buf), WSI_TOKEN_HTTP_ACCEPT_ENCODING);
  return len > 0 && strstr(buf, "gzip") != NULL;
}

static bool uncompress_html(char **output, size_t *output_len) {
  if (html_cache == NULL || html_cache_len == 0) {
    z_stream stream;
    memset(&stream, 0, sizeof(stream));
    if (inflateInit2(&stream, 16 + 15) != Z_OK) return false;

    html_cache_len = index_html_size;
    html_cache = xmalloc(html_cache_len);

    stream.avail_in = index_html_len;
    stream.avail_out = html_cache_len;
    stream.next_in = (void *)index_html;
    stream.next_out = (void *)html_cache;

    int ret = inflate(&stream, Z_SYNC_FLUSH);
    inflateEnd(&stream);
    if (ret != Z_STREAM_END) {
      free(html_cache);
      html_cache = NULL;
      html_cache_len = 0;
      return false;
    }
  }

  *output = html_cache;
  *output_len = html_cache_len;

  return true;
}

static void pss_buffer_free(struct pss_http *pss) {
  if (pss->buffer != (char *)index_html && pss->buffer != html_cache) free(pss->buffer);
}

// Queue the JSON answer to a POST. json-c performs the actual escaping in the
// writable callback; these fields only retain the values until then.
static void json_result(struct pss_http *pss, int status, const char *path, const char *error) {
  snprintf(pss->json_path, sizeof(pss->json_path), "%s", path != NULL ? path : "");
  snprintf(pss->json_error, sizeof(pss->json_error), "%s", error != NULL ? error : "");
  pss->json_status = status;
  pss->json_reply = true;
  lws_callback_on_writable(pss->wsi);
}

static void image_upload_done(void *ctx, int status, const char *path, const char *error) {
  struct pss_http *pss = (struct pss_http *)ctx;

  pss->image_upload = NULL;
  json_result(pss, status == 0 ? HTTP_STATUS_OK : HTTP_STATUS_INTERNAL_SERVER_ERROR, path, error);
}

static void request_reset(struct pss_http *pss) {
  if (pss->image_upload != NULL) {
    image_upload_detach(pss->image_upload);
    pss->image_upload = NULL;
  }
  free(pss->body);
  pss->body = NULL;
  pss->body_len = 0;
  pss->body_max = 0;
  pss->body_too_large = false;
  pss->post = POST_NONE;
  pss->json_reply = false;
  pss->json_path[0] = '\0';
  pss->json_error[0] = '\0';
  pss->cookie[0] = '\0';
}

// Whole-file read, used to answer GET /tabs and to load the session list.
// Returns a NUL-terminated buffer the caller owns, or NULL when the file is
// missing or unreadable — which is not an error: a deployment that has never
// saved a layout, or never had anyone log in, simply has no file yet.
static char *read_file(const char *path, size_t *out_len) {
  FILE *fp = fopen(path, "rb");
  if (fp == NULL) return NULL;

  if (fseek(fp, 0, SEEK_END) != 0) {
    fclose(fp);
    return NULL;
  }
  long size = ftell(fp);
  if (size < 0 || size > MAX_TABS_BYTES || fseek(fp, 0, SEEK_SET) != 0) {
    fclose(fp);
    return NULL;
  }

  char *buf = xmalloc((size_t)size + 1);
  size_t n = fread(buf, 1, (size_t)size, fp);
  fclose(fp);
  buf[n] = '\0';
  *out_len = n;
  return buf;
}

// Replace `path` with `data`. Written to a sibling temp file and renamed, so a
// reader (or a crash) never sees a half-written layout — losing the tab list
// to a torn write would be worse than not saving it at all. Returns an errno
// on failure, 0 on success.
static int write_file_atomic(const char *path, const char *data, size_t len) {
  char *tmp = xmalloc(strlen(path) + 8);
  sprintf(tmp, "%s.XXXXXX", path);

  int fd = mkstemp(tmp);
  if (fd < 0) {
    int err = errno;
    free(tmp);
    return err;
  }

  int err = 0;
  size_t off = 0;
  while (off < len) {
    ssize_t written = write(fd, data + off, len - off);
    if (written < 0) {
      err = errno;
      break;
    }
    off += (size_t)written;
  }
  if (err == 0 && fsync(fd) != 0) err = errno;
  if (close(fd) != 0 && err == 0) err = errno;

  if (err == 0) {
    // 0600: the layout names every session the user has open.
    if (chmod(tmp, S_IRUSR | S_IWUSR) != 0) err = errno;
  }
  if (err == 0 && rename(tmp, path) != 0) err = errno;
  if (err != 0) unlink(tmp);

  free(tmp);
  return err;
}

// ── login sessions ─────────────────────────────────────────────────────────
//
// Basic auth alone means a password prompt every time the browser forgets the
// credential, which it does often: a restart, a fresh PWA window, a phone that
// dropped the tab. So the first successful basic-auth also hands out a cookie
// holding a random token, and any later request carrying that token is let
// through without the header. The tokens live here, not in the cookie, so
// deleting the file logs every browser out.

struct auth_session {
  char token[SESSION_TOKEN_HEX + 1];
  long long expiry;  // unix seconds
};

static struct auth_session sessions[MAX_SESSIONS];
static int session_count = 0;
static bool sessions_loaded = false;

enum { SESSION_UNKNOWN, SESSION_OK, SESSION_RENEWED };

// FNV-1a over the encoded credential. Written into the session file so that a
// changed password invalidates every token issued under the old one — the
// stored list is only meaningful for the credential that created it.
static unsigned long long cred_fingerprint(void) {
  unsigned long long h = 1469598103934665603ULL;
  for (const char *s = server->credential != NULL ? server->credential : ""; *s != '\0'; s++) {
    h ^= (unsigned char)*s;
    h *= 1099511628211ULL;
  }
  return h;
}

static bool is_hex_token(const char *s) {
  for (size_t i = 0; i < SESSION_TOKEN_HEX; i++) {
    char c = s[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return s[SESSION_TOKEN_HEX] == '\0';
}

static void sessions_load(void) {
  if (sessions_loaded) return;
  sessions_loaded = true;  // a missing or unreadable file just means no sessions yet
  if (server->session_file == NULL) return;

  size_t len = 0;
  char *data = read_file(server->session_file, &len);
  if (data == NULL) return;

  char *save = NULL;
  char *line = strtok_r(data, "\n", &save);
  unsigned long long stored = 0;
  if (line == NULL || sscanf(line, "ttyd-session 1 %llu", &stored) != 1 || stored != cred_fingerprint()) {
    free(data);
    return;
  }

  long long now = (long long)time(NULL);
  while ((line = strtok_r(NULL, "\n", &save)) != NULL && session_count < MAX_SESSIONS) {
    char token[SESSION_TOKEN_HEX + 1];
    long long expiry;
    if (sscanf(line, "%64s %lld", token, &expiry) != 2) continue;
    if (!is_hex_token(token) || expiry <= now) continue;
    memcpy(sessions[session_count].token, token, sizeof(token));
    sessions[session_count].expiry = expiry;
    session_count++;
  }

  free(data);
}

static void sessions_save(void) {
  if (server->session_file == NULL) return;

  size_t cap = 64 + (size_t)session_count * (SESSION_TOKEN_HEX + 24);
  char *buf = xmalloc(cap);
  size_t n = (size_t)snprintf(buf, cap, "ttyd-session 1 %llu\n", cred_fingerprint());
  for (int i = 0; i < session_count; i++)
    n += (size_t)snprintf(buf + n, cap - n, "%s %lld\n", sessions[i].token, sessions[i].expiry);

  int err = write_file_atomic(server->session_file, buf, n);
  // Not fatal: the sessions still work for as long as this process runs, they
  // just won't survive a restart.
  if (err != 0) lwsl_warn("session: cannot write %s: %s\n", server->session_file, strerror(err));
  free(buf);
}

static bool sessions_prune(long long now) {
  int kept = 0;
  for (int i = 0; i < session_count; i++)
    if (sessions[i].expiry > now) sessions[kept++] = sessions[i];

  bool dropped = kept != session_count;
  session_count = kept;
  return dropped;
}

// Fixed-length compare that always walks the whole token, so how long the
// answer takes says nothing about how much of a guess was right.
static bool token_equal(const char *a, const char *b) {
  unsigned char diff = 0;
  for (size_t i = 0; i < SESSION_TOKEN_HEX; i++) diff |= (unsigned char)(a[i] ^ b[i]);
  return diff == 0;
}

// Look a cookie token up. Past the halfway mark the deadline is pushed back
// (and the caller re-sends the cookie), so a browser in regular use never sees
// the password prompt again while one that stops coming back still expires on
// schedule.
static int session_accept(const char *token) {
  sessions_load();

  long long now = (long long)time(NULL);
  bool dirty = sessions_prune(now);
  int result = SESSION_UNKNOWN;

  for (int i = 0; i < session_count; i++) {
    if (!token_equal(sessions[i].token, token)) continue;
    result = SESSION_OK;
    if (sessions[i].expiry - now < server->auth_max_age / 2) {
      sessions[i].expiry = now + server->auth_max_age;
      result = SESSION_RENEWED;
      dirty = true;
    }
    break;
  }

  if (dirty) sessions_save();
  return result;
}

// Mint a token for a browser that just proved it knows the password. Writes
// SESSION_TOKEN_HEX + 1 bytes into `out`; leaves it empty if the platform
// could not give us enough randomness, in which case the login still works,
// it just doesn't get a cookie.
static void session_issue(char *out) {
  unsigned char raw[SESSION_TOKEN_BYTES];
  if (lws_get_random(context, raw, sizeof(raw)) != sizeof(raw)) {
    lwsl_warn("session: no randomness available, issuing no cookie\n");
    out[0] = '\0';
    return;
  }

  static const char hex[] = "0123456789abcdef";
  for (size_t i = 0; i < sizeof(raw); i++) {
    out[i * 2] = hex[raw[i] >> 4];
    out[i * 2 + 1] = hex[raw[i] & 0xf];
  }
  out[SESSION_TOKEN_HEX] = '\0';

  sessions_load();
  long long now = (long long)time(NULL);
  sessions_prune(now);

  if (session_count == MAX_SESSIONS) {
    int oldest = 0;
    for (int i = 1; i < session_count; i++)
      if (sessions[i].expiry < sessions[oldest].expiry) oldest = i;
    memmove(&sessions[oldest], &sessions[oldest + 1], (size_t)(session_count - oldest - 1) * sizeof(sessions[0]));
    session_count--;
  }

  memcpy(sessions[session_count].token, out, SESSION_TOKEN_HEX + 1);
  sessions[session_count].expiry = now + server->auth_max_age;
  session_count++;
  sessions_save();
}

// Pull our token out of the Cookie header, into a buffer of at least
// SESSION_TOKEN_HEX + 1 bytes. Anything the wrong length is not a token we
// ever issued, so it is treated as absent.
static bool cookie_token(struct lws *wsi, char *out) {
  char buf[1024];
  if (lws_hdr_copy(wsi, buf, sizeof(buf), WSI_TOKEN_HTTP_COOKIE) <= 0) return false;

  for (char *p = buf; p != NULL && *p != '\0';) {
    while (*p == ' ' || *p == ';') p++;
    char *sep = strchr(p, ';');
    if (sep != NULL) *sep = '\0';

    if (!strncmp(p, AUTH_COOKIE "=", sizeof(AUTH_COOKIE))) {
      char *value = p + sizeof(AUTH_COOKIE);
      if (strlen(value) != SESSION_TOKEN_HEX) return false;
      memcpy(out, value, SESSION_TOKEN_HEX + 1);
      return true;
    }
    p = sep != NULL ? sep + 1 : NULL;
  }

  return false;
}

// Attach the Set-Cookie for a session just issued or renewed. Path is the base
// path, so a ttyd mounted under a prefix does not hand its cookie to the rest
// of the site. Secure only when the request actually arrived over TLS: the
// usual deployment is plain HTTP behind a tunnel, and a browser drops a Secure
// cookie that came over http — which would mean the password prompt forever.
static int add_session_cookie(struct lws *wsi, struct pss_http *pss, unsigned char **p, unsigned char *end) {
  if (pss->cookie[0] == '\0') return 0;

  char proto[16];
  bool secure = lws_is_ssl(wsi) || (lws_hdr_custom_copy(wsi, proto, sizeof(proto), "x-forwarded-proto:", 18) > 0 &&
                                    !strcmp(proto, "https"));

  char value[256];
  int n = snprintf(value, sizeof(value), "%s=%s; Path=%s; Max-Age=%d; HttpOnly; SameSite=Lax%s", AUTH_COOKIE,
                   pss->cookie, endpoints.parent[0] ? endpoints.parent : "/", server->auth_max_age,
                   secure ? "; Secure" : "");

  return lws_add_http_header_by_name(wsi, (unsigned char *)"set-cookie:", (unsigned char *)value, n, p, end);
}

static int send_unauthorized(struct lws *wsi, unsigned int code, enum lws_token_indexes header) {
  unsigned char buffer[1024 + LWS_PRE], *p, *end;
  p = buffer + LWS_PRE;
  end = p + sizeof(buffer) - LWS_PRE;

  if (lws_add_http_header_status(wsi, code, &p, end) ||
      lws_add_http_header_by_token(wsi, header, (unsigned char *)"Basic realm=\"ttyd\"", 18, &p, end) ||
      lws_add_http_header_content_length(wsi, 0, &p, end) || lws_finalize_http_header(wsi, &p, end) ||
      lws_write(wsi, buffer + LWS_PRE, p - (buffer + LWS_PRE), LWS_WRITE_HTTP_HEADERS) < 0)
    return AUTH_FAIL;

  return lws_http_transaction_completed(wsi) ? AUTH_FAIL : AUTH_ERROR;
}

static int check_auth(struct lws *wsi, struct pss_http *pss) {
  if (server->auth_header != NULL) {
    if (lws_hdr_custom_length(wsi, server->auth_header, strlen(server->auth_header)) > 0) return AUTH_OK;
    return send_unauthorized(wsi, HTTP_STATUS_PROXY_AUTH_REQUIRED, WSI_TOKEN_HTTP_PROXY_AUTHENTICATE);
  }

  if(server->credential != NULL) {
    // A cookie from an earlier login stands in for the credential. An unknown
    // one is not an error — it may be from before a password change — it just
    // falls through to the header check below.
    char token[SESSION_TOKEN_HEX + 1];
    if (server->auth_max_age > 0 && cookie_token(wsi, token)) {
      switch (session_accept(token)) {
        case SESSION_RENEWED:
          memcpy(pss->cookie, token, sizeof(token));
          return AUTH_OK;
        case SESSION_OK:
          return AUTH_OK;
        default:
          break;
      }
    }

    char buf[256];
    int len = lws_hdr_copy(wsi, buf, sizeof(buf), WSI_TOKEN_HTTP_AUTHORIZATION);
    if (len >= 7 && strstr(buf, "Basic ")) {
      if (!strcmp(buf + 6, server->credential)) {
        if (server->auth_max_age > 0) session_issue(pss->cookie);
        return AUTH_OK;
      }
    }
    return send_unauthorized(wsi, HTTP_STATUS_UNAUTHORIZED, WSI_TOKEN_HTTP_WWW_AUTHENTICATE);
  }

  return AUTH_OK;
}

// Store the body of a POST /tabs. The blob is opaque to the server — only the
// UI knows what a tab is — but it has to be valid JSON, so a malformed request
// can't leave the file unparseable for every future reader.
static void tabs_store(struct pss_http *pss) {
  struct json_object *parsed = json_tokener_parse(pss->body);
  if (parsed == NULL) {
    json_result(pss, HTTP_STATUS_BAD_REQUEST, NULL, "not valid json");
    return;
  }
  json_object_put(parsed);

  int err = write_file_atomic(server->tabs_file, pss->body, pss->body_len);
  if (err != 0) {
    lwsl_err("tabs: cannot write %s: %s\n", server->tabs_file, strerror(err));
    json_result(pss, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL, strerror(err));
    return;
  }
  json_result(pss, HTTP_STATUS_OK, NULL, NULL);
}

static void access_log(struct lws *wsi, const char *path) {
  char rip[50];

  lws_get_peer_simple(lws_get_network_wsi(wsi), rip, sizeof(rip));
  lwsl_notice("HTTP %s - %s\n", path, rip);
}

int callback_http(struct lws *wsi, enum lws_callback_reasons reason, void *user, void *in, size_t len) {
  struct pss_http *pss = (struct pss_http *)user;
  unsigned char buffer[4096 + LWS_PRE], *p, *end;
  char buf[256];
  bool done = false;

  switch (reason) {
    case LWS_CALLBACK_HTTP:
      access_log(wsi, (const char *)in);
      snprintf(pss->path, sizeof(pss->path), "%s", (const char *)in);
      pss->wsi = wsi;
      request_reset(pss);  // the connection may be reused across requests
      switch (check_auth(wsi, pss)) {
        case AUTH_OK:
          break;
        case AUTH_FAIL:
          return 0;
        case AUTH_ERROR:
        default:
          return 1;
      }

      p = buffer + LWS_PRE;
      end = p + sizeof(buffer) - LWS_PRE;

      if (strcmp(pss->path, endpoints.token) == 0) {
        const char *credential = server->credential != NULL ? server->credential : "";
        size_t n = snprintf(buf, sizeof(buf), "{\"token\": \"%s\"}", credential);
        if (lws_add_http_header_status(wsi, HTTP_STATUS_OK, &p, end) ||
            lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_CONTENT_TYPE,
                                         (unsigned char *)"application/json;charset=utf-8", 30, &p, end) ||
            add_session_cookie(wsi, pss, &p, end) ||
            lws_add_http_header_content_length(wsi, (unsigned long)n, &p, end) ||
            lws_finalize_http_header(wsi, &p, end) ||
            lws_write(wsi, buffer + LWS_PRE, p - (buffer + LWS_PRE), LWS_WRITE_HTTP_HEADERS) < 0)
          return 1;

        pss->buffer = pss->ptr = strdup(buf);
        pss->len = n;
        lws_callback_on_writable(wsi);
        break;
      }

      // Image paste bridge. The browser stores the image on the ttyd host.
      // Codex consumes the returned path directly; Claude reads the published
      // PNG through the deployment's X11-free xclip compatibility helper.
      if (strcmp(pss->path, endpoints.image) == 0) {
        if (lws_hdr_total_length(wsi, WSI_TOKEN_POST_URI) == 0) {
          lws_return_http_status(wsi, HTTP_STATUS_METHOD_NOT_ALLOWED, NULL);
          goto try_to_reuse;
        }
        // Answer from LWS_CALLBACK_HTTP_BODY_COMPLETION once the worker has
        // durably stored the image.
        pss->post = POST_IMAGE;
        pss->body_max = MAX_IMAGE_BYTES;
        return 0;
      }

      // Tab layout. localStorage keeps the tab list per browser, so the same
      // deployment opened from a phone and a laptop shows two unrelated sets
      // of tabs and a cleared cache loses them. This is where the UI parks the
      // list instead: a single opaque JSON blob, GET to read, POST to replace.
      // Off unless the deployment named a file to keep it in.
      if (strcmp(pss->path, endpoints.tabs) == 0) {
        if (server->tabs_file == NULL) {
          lws_return_http_status(wsi, HTTP_STATUS_NOT_FOUND, NULL);
          goto try_to_reuse;
        }
        if (lws_hdr_total_length(wsi, WSI_TOKEN_POST_URI) > 0) {
          // Answered from LWS_CALLBACK_HTTP_BODY_COMPLETION.
          pss->post = POST_TABS;
          pss->body_max = MAX_TABS_BYTES;
          return 0;
        }

        size_t saved_len = 0;
        char *saved = read_file(server->tabs_file, &saved_len);
        if (saved == NULL) {
          // Nothing saved yet — an empty object, so the client can treat "no
          // layout on the server" the same as "a layout with nothing in it".
          saved = strdup("{}");
          saved_len = 2;
        }
        if (lws_add_http_header_status(wsi, HTTP_STATUS_OK, &p, end) ||
            lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_CONTENT_TYPE,
                                         (unsigned char *)"application/json;charset=utf-8", 30, &p, end) ||
            lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_CACHE_CONTROL, (unsigned char *)"no-store", 8, &p, end) ||
            add_session_cookie(wsi, pss, &p, end) ||
            lws_add_http_header_content_length(wsi, (unsigned long)saved_len, &p, end) ||
            lws_finalize_http_header(wsi, &p, end) ||
            lws_write(wsi, buffer + LWS_PRE, p - (buffer + LWS_PRE), LWS_WRITE_HTTP_HEADERS) < 0) {
          free(saved);
          return 1;
        }

        pss->buffer = pss->ptr = saved;
        pss->len = saved_len;
        lws_callback_on_writable(wsi);
        break;
      }

      // redirects `/base-path` to `/base-path/`
      if (strcmp(pss->path, endpoints.parent) == 0) {
        if (lws_add_http_header_status(wsi, HTTP_STATUS_FOUND, &p, end) ||
            lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_LOCATION, (unsigned char *)endpoints.index,
                                         (int)strlen(endpoints.index), &p, end) ||
            add_session_cookie(wsi, pss, &p, end) ||
            lws_add_http_header_content_length(wsi, 0, &p, end) || lws_finalize_http_header(wsi, &p, end) ||
            lws_write(wsi, buffer + LWS_PRE, p - (buffer + LWS_PRE), LWS_WRITE_HTTP_HEADERS) < 0)
          return 1;
        goto try_to_reuse;
      }

      if (strcmp(pss->path, endpoints.index) != 0) {
        lws_return_http_status(wsi, HTTP_STATUS_NOT_FOUND, NULL);
        goto try_to_reuse;
      }

      const char *content_type = "text/html";
      if (server->index != NULL) {
        // No Set-Cookie here: lws owns the whole header block for a served
        // file. A custom index still gets one, from the /token request the UI
        // makes as soon as it loads.
        int n = lws_serve_http_file(wsi, server->index, content_type, NULL, 0);
        if (n < 0 || (n > 0 && lws_http_transaction_completed(wsi))) return 1;
      } else {
        char *output = (char *)index_html;
        size_t output_len = index_html_len;
        if (lws_add_http_header_status(wsi, HTTP_STATUS_OK, &p, end) ||
            lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_CONTENT_TYPE, (const unsigned char *)content_type, 9, &p,
                                         end) ||
            add_session_cookie(wsi, pss, &p, end))
          return 1;
#ifdef LWS_WITH_HTTP_STREAM_COMPRESSION
        if (!uncompress_html(&output, &output_len)) return 1;
#else
        if (accept_gzip(wsi)) {
          if (lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_CONTENT_ENCODING, (unsigned char *)"gzip", 4, &p, end))
            return 1;
        } else {
          if (!uncompress_html(&output, &output_len)) return 1;
        }
#endif

        if (lws_add_http_header_content_length(wsi, (unsigned long)output_len, &p, end) ||
            lws_finalize_http_header(wsi, &p, end) ||
            lws_write(wsi, buffer + LWS_PRE, p - (buffer + LWS_PRE), LWS_WRITE_HTTP_HEADERS) < 0)
          return 1;

        pss->buffer = pss->ptr = output;
        pss->len = output_len;
        lws_callback_on_writable(wsi);
      }
      break;

    case LWS_CALLBACK_HTTP_BODY:
      // lws signals a bodyless POST with a zero-length chunk and a NULL `in`.
      if (pss->post == POST_NONE || pss->body_too_large || len == 0) break;

      // Overshooting the cap discards what was buffered: the body is useless
      // now, and holding it would let a single request pin the memory until
      // the client finishes uploading.
      if (pss->body_len + len > pss->body_max) {
        pss->body_too_large = true;
        free(pss->body);
        pss->body = NULL;
        pss->body_len = 0;
        break;
      }

      // One extra byte, always kept NUL: the tabs handler parses the body as a
      // C string and a JSON parser must not run off the end of it.
      pss->body = xrealloc(pss->body, pss->body_len + len + 1);
      memcpy(pss->body + pss->body_len, in, len);
      pss->body_len += len;
      pss->body[pss->body_len] = '\0';
      break;

    case LWS_CALLBACK_HTTP_BODY_COMPLETION:
      if (pss->post == POST_NONE) goto try_to_reuse;

      if (pss->body_too_large) {
        json_result(pss, HTTP_STATUS_REQ_ENTITY_TOO_LARGE, NULL, "body too large");
      } else if (pss->body_len == 0) {
        json_result(pss, HTTP_STATUS_BAD_REQUEST, NULL, "empty body");
      } else if (pss->post == POST_TABS) {
        tabs_store(pss);
      } else {
        static const unsigned char png_signature[] = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'};
        if (pss->body_len < sizeof(png_signature) ||
            memcmp(pss->body, png_signature, sizeof(png_signature)) != 0) {
          json_result(pss, HTTP_STATUS_BAD_REQUEST, NULL, "body is not a PNG image");
          return 0;
        }

        int err = 0;
        char *data = pss->body;
        size_t data_len = pss->body_len;
        pss->body = NULL;  // ownership passes to the image worker
        pss->body_len = 0;

        pss->image_upload = image_upload_store(server->loop, data, data_len, image_upload_done, pss, &err);
        if (pss->image_upload == NULL)
          json_result(pss, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL, uv_strerror(err));
      }
      return 0;

    case LWS_CALLBACK_CLOSED_HTTP:
      request_reset(pss);
      break;

    case LWS_CALLBACK_HTTP_WRITEABLE:
      if (pss->json_reply) {
        pss->json_reply = false;
        pss->post = POST_NONE;

        json_object *reply = json_object_new_object();
        if (pss->json_status == HTTP_STATUS_OK && pss->json_path[0] != '\0')
          json_object_object_add(reply, "path", json_object_new_string(pss->json_path));
        else if (pss->json_status == HTTP_STATUS_OK)
          json_object_object_add(reply, "ok", json_object_new_boolean(true));
        else
          json_object_object_add(reply, "error", json_object_new_string(pss->json_error));
        const char *json = json_object_to_json_string_ext(reply, JSON_C_TO_STRING_PLAIN);
        size_t n = strlen(json);

        p = buffer + LWS_PRE;
        end = p + sizeof(buffer) - LWS_PRE;
        if (lws_add_http_header_status(wsi, (unsigned int)pss->json_status, &p, end) ||
            lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_CONTENT_TYPE,
                                         (unsigned char *)"application/json;charset=utf-8", 30, &p, end) ||
            add_session_cookie(wsi, pss, &p, end) ||
            lws_add_http_header_content_length(wsi, (unsigned long)n, &p, end) ||
            lws_finalize_http_header(wsi, &p, end) ||
            lws_write(wsi, buffer + LWS_PRE, p - (buffer + LWS_PRE), LWS_WRITE_HTTP_HEADERS) < 0)
          return 1;

        pss->buffer = pss->ptr = strdup(json);
        pss->len = n;
        json_object_put(reply);
        // fall through to write the body out below
      }

      if (!pss->buffer || pss->len == 0) {
        goto try_to_reuse;
      }

      do {
        int n = sizeof(buffer) - LWS_PRE;
        int m = lws_get_peer_write_allowance(wsi);
        if (m == 0) {
          lws_callback_on_writable(wsi);
          return 0;
        } else if (m != -1 && m < n) {
          n = m;
        }
        if (pss->ptr + n > pss->buffer + pss->len) {
          n = (int)(pss->len - (pss->ptr - pss->buffer));
          done = true;
        }
        memcpy(buffer + LWS_PRE, pss->ptr, n);
        pss->ptr += n;
        if (lws_write_http(wsi, buffer + LWS_PRE, (size_t)n) < n) {
          pss_buffer_free(pss);
          return -1;
        }
      } while (!lws_send_pipe_choked(wsi) && !done);

      if (!done && pss->ptr < pss->buffer + pss->len) {
        lws_callback_on_writable(wsi);
        break;
      }

      pss_buffer_free(pss);
      goto try_to_reuse;

    case LWS_CALLBACK_HTTP_FILE_COMPLETION:
      goto try_to_reuse;
#if (defined(LWS_OPENSSL_SUPPORT) || defined(LWS_WITH_TLS)) && !defined(LWS_WITH_MBEDTLS)
    case LWS_CALLBACK_OPENSSL_PERFORM_CLIENT_CERT_VERIFICATION:
      if (!len || (SSL_get_verify_result((SSL *)in) != X509_V_OK)) {
        int err = X509_STORE_CTX_get_error((X509_STORE_CTX *)user);
        int depth = X509_STORE_CTX_get_error_depth((X509_STORE_CTX *)user);
        const char *msg = X509_verify_cert_error_string(err);
        lwsl_err("client certificate verification error: %s (%d), depth: %d\n", msg, err, depth);
        return 1;
      }
      break;
#endif
    default:
      break;
  }

  return 0;

  /* if we're on HTTP1.1 or 2.0, will keep the idle connection alive */
try_to_reuse:
  if (lws_http_transaction_completed(wsi)) return -1;

  return 0;
}
