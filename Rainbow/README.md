# Pixso2Figma

Pixso2Figma is an unofficial, independent Figma plugin for importing designs from files exported by Pixso.

The project provides a convenient way to transfer a user-provided exported design into Figma while preserving the design structure and supported properties where possible.

**Rainbow** is the current build of Pixso2Figma.

## How It Works

1. Export your design from Pixso using Pixso's standard export functionality.
2. Provide the exported file to Pixso2Figma.
3. Pixso2Figma processes the local file and transfers the supported design data into Figma.

Pixso2Figma operates on files explicitly provided by the user.

## Running Pixso2Figma

1. In Figma, import `FigmaImporter/manifest.json` as a development plugin.
2. Open the destination document, run **Pixso2Figma**, and start the Receiver.
3. Double-click `Pixso2Figma.command` on macOS or `Pixso2Figma.cmd` on Windows.
4. Drag one saved `.pix` file into the terminal window and press Enter.

A separate Node.js installation is optional. The launcher uses a compatible
system Node.js when available. Otherwise it automatically downloads a private,
checksum-verified Node.js runtime from `nodejs.org` into the current user's
application-data folder. This does not require administrator rights and does not
modify `PATH`. The first launch requires internet access only when a compatible
Node.js is not already installed; later launches use the cached runtime offline.

On Windows, startup diagnostics are written to
`%LOCALAPPDATA%\Pixso2Figma\launcher.log`, and startup failures leave the terminal
window open so the error can be read.

## Independent Project

Pixso2Figma is an independent, unofficial project.

It is **not affiliated with, endorsed by, sponsored by, or developed by Pixso or Figma**.

Pixso and Figma are trademarks of their respective owners. Their names are used solely to describe compatibility and the intended purpose of this software.

## About Pixso

Pixso2Figma does not connect to Pixso accounts or require Pixso credentials.

The project does not use Pixso authentication, user sessions, private APIs, or internal services.

Pixso2Figma was developed independently based on:

- files exported through Pixso's standard export functionality;
- publicly available documentation;
- independent analysis of the structure of user-exported files for the purpose of interoperability.

The project does not contain or distribute Pixso source code, proprietary application components, or internal libraries.

No Pixso application code was decompiled or reverse engineered in the development of this project.

## User Content

Pixso2Figma processes files provided by the user.

Users are responsible for ensuring that they have the necessary rights and permissions to process, convert, and use the content contained in those files.

Pixso2Figma does not grant any rights to third-party designs, images, fonts, assets, trademarks, or other content that may be present in user-provided files.

## Compatibility

Pixso2Figma is an independent interoperability tool.

Compatibility with particular Pixso or Figma versions is not guaranteed. Changes made by either platform may affect the functionality of the plugin.

## License

The **Rainbow** build of Pixso2Figma is distributed under the **PolyForm Strict License 1.0.0**.

The software may be used for permitted non-commercial purposes under the terms of the license.

The license does **not** grant general permission to modify or redistribute this version of the software.

Commercial use requires separate permission or a separate commercial license from the copyright holder.

See the [`LICENSE`](./LICENSE) file for the complete license terms.

## Disclaimer

Pixso2Figma is provided on an "as is" basis, without warranties or guarantees of compatibility, availability, or fitness for a particular purpose.

This project is not an official Pixso or Figma product.
