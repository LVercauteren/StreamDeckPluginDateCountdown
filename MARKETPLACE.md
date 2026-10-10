# Elgato Marketplace checklist

Verify against the Elgato Stream Deck SDK docs before submitting.

- [ ] `manifest.json`: Name, Author, Description, Version, Icon, CategoryIcon, SDKVersion, Software.MinimumVersion
- [ ] OS list: currently Windows only; consider adding macOS if the plugin is compatible
- [ ] Plugin icon, category icon and action icons provided at the sizes required by the Elgato guidelines
- [ ] Marketplace preview/thumbnail images prepared per Elgato guidelines
- [ ] `streamdeck validate` passes (Elgato CLI)
- [ ] `streamdeck pack` produces the `.streamDeckPlugin` file
- [ ] Submit through the Elgato Maker Console
