package com.floodsense.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // native screen keep-awake for navigation (js/mobile.js calls it as navigator.wakeLock)
        registerPlugin(KeepAwakePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
