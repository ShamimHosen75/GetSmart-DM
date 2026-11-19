package com.sidm.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities

/** Is there internet, and is it Wi-Fi (not metered)? Calls [onChange] when that changes. */
class Net(context: Context, onChange: () -> Unit) {
    private val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    init {
        cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = onChange()
            override fun onLost(network: Network) = onChange()
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = onChange()
        })
    }

    private fun caps(): NetworkCapabilities? = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) }

    val online: Boolean
        get() = caps()?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true

    val unmetered: Boolean
        get() = caps()?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) == true
}
