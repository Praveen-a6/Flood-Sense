package com.floodsense.app;

import android.view.WindowManager;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Tiny native plugin: keeps the screen on while turn-by-turn navigation is running.
 * The Android WebView has no Screen Wake Lock API, so js/mobile.js maps
 * navigator.wakeLock onto this plugin.
 */
@CapacitorPlugin(name = "KeepAwake")
public class KeepAwakePlugin extends Plugin {

    @PluginMethod
    public void enable(PluginCall call) {
        getActivity().runOnUiThread(() ->
                getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON));
        call.resolve();
    }

    @PluginMethod
    public void disable(PluginCall call) {
        getActivity().runOnUiThread(() ->
                getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON));
        call.resolve();
    }
}
