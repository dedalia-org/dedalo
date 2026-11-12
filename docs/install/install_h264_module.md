# Serving audiovisual fragments (H.264 clipping)

> See also: [Installation hub](index.md) · [The web server site](reverse_proxy.md) · [Media protection](../administration/configuration/media_protection.md)

Dédalo publishes audiovisual **fragments**: an oral-history interview is one long
recording, and a record points at a segment of it. Playing that segment without
cutting a new file requires the **web server** to serve a time range of an MP4 on
demand — it reads the MPEG-4 index (ISO/IEC 14496-12), finds the in and out
positions, and streams just that span as a valid, standalone MP4.

This is a **media-serving** concern. It is entirely a web-server capability;
Dédalo only produces the URLs.

```text
…/dedalo/media/av/404/<file>.mp4?start=812.4&end=948.0
                                 ^^^^^^^^^^^^^^^^^^^^^
                                 handled by the web server, never by the engine
```

!!! note "You need this if you do oral history or audiovisual archives"
    Without it, a fragment player has to download the whole file and seek — which
    works, badly, for a 90-minute interview. With it, playback starts at the
    in-point immediately.

## nginx: already built in

nginx ships the equivalent as `ngx_http_mp4_module`, and it is compiled into the
official packages and images. **You do not install anything** — the generated
media rules already emit the `mp4;` directive inside the media locations.

Verify it is there:

```shell
nginx -V 2>&1 | tr ' ' '\n' | grep http_mp4_module
# --with-http_mp4_module
```

If it is missing, your nginx was built without it — install the distribution's
standard package rather than a stripped one.

## Apache: an extra module

Apache needs the Dédalo H.264 streaming module,
`mod_dedalo_h264_streaming`. It is distributed as a source tree and as
prebuilt shared objects per platform.

!!! warning "Where to get it"
    The module is **not vendored in this repository**. Obtain it from your Dédalo
    distribution, or build it from source (below). If you cannot find it, use
    nginx — where the equivalent is built in and needs nothing.

### Install a prebuilt module

On Debian and Ubuntu:

```shell
cp mod_dedalo_h264_streaming.so /usr/lib/apache2/modules/
cp dedalo_h264.load /etc/apache2/mods-available/
a2enmod dedalo_h264
systemctl restart apache2
```

On the RHEL family (RHEL, Rocky Linux, AlmaLinux):

```shell
cp mod_dedalo_h264_streaming.so /usr/lib64/httpd/modules/
cp dedalo_h264.load /etc/httpd/conf.modules.d/00-dedaloh264.conf
systemctl restart httpd
```

### Build it from source

Install the Apache development headers:

```shell
apt install apache2-dev                        # Debian / Ubuntu

dnf groupinstall "Development Tools"           # the RHEL family
dnf install httpd-devel
```

```shell
cd mod_h264_streaming-3.0.0
./configure
make
sudo make install
```

??? tip "macOS"
    Apple removed `apxs` in 10.13+, so point `configure` at Homebrew's copy:

    ```shell
    ./configure --with-apxs='/opt/homebrew/Cellar/httpd/2.4.57_1/bin/apxs'
    make
    sudo make install
    ```

## It composes with the media access gate

Clipping and access control operate on the same request, and they were designed
not to interfere:

- **The gate never rewrites the URL.** The generated rules test whether a marker
  file exists and then get out of the way — the substitution is always a no-op
  and **the query string is never touched**, so `?start=` and `?end=` reach the
  clipping handler intact.
- **The gate is a `stat()`, not a proxy.** No Dédalo process is ever in the media
  byte path, so `sendfile`, HTTP `Range` and the clipping handler all keep
  working on multi-gigabyte files.
- **Authorisation still applies to a fragment.** A clipped range of an
  unpublished record is denied exactly like the whole file — the gate runs first.

## Requirements on the file itself

The MP4 index must be at the **front** of the file, or the handler has to read to
the end before it can serve anything. That is what `qt-faststart` does, and it is
why the [media toolchain](production.md#host_packages-packages-and-repositories) includes it. Check it:

```shell
command -v qt-faststart
```

If it lives somewhere unusual, declare it:

```dotenv
DEDALO_AV_FASTSTART_PATH=/usr/local/bin/qt-faststart
```

## Verify

```shell
# A published fragment: 200, and much smaller than the whole file.
curl -sk -o /dev/null -w '%{size_download}\n' \
  'https://dedalo.example.org/dedalo/media/av/404/<a-real-file>.mp4?start=10&end=20'

# The same file whole, for comparison.
curl -sk -o /dev/null -w '%{size_download}\n' \
  'https://dedalo.example.org/dedalo/media/av/404/<a-real-file>.mp4'
```

If the two numbers are the same, the clipping handler is not active: the module
is not loaded (Apache), or the `mp4;` directive is not in the media location
(nginx — it is emitted by the generated rules, so check that they are included).
