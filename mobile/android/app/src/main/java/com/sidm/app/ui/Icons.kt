package com.sidm.app.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/** The few icons SIDM needs that are not in Compose's core icon set. Drawn on a 24x24 grid. */
object SidmIcons {
    private fun icon(name: String, vararg paths: String): ImageVector {
        val b = ImageVector.Builder(name = name, defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f)
        paths.forEach { b.addPath(pathData = addPathNodes(it), pathFillType = PathFillType.EvenOdd, fill = SolidColor(Color.Black)) }
        return b.build()
    }

    /** Down arrow over a tray: SIDM's mark. */
    val Download = icon("Download", "M10.5,3h3v8h3.5l-5,5.5l-5,-5.5h3.5z", "M5,18.5h14v2.5h-14z")
    val Pause = icon("Pause", "M6,5h4v14h-4z", "M14,5h4v14h-4z")
    val Globe = icon(
        "Globe",
        "M12,2a10,10 0 1,0 0.01,0zM12,4c0.9,0 2.2,1.6 2.9,5h-5.8c0.7,-3.4 2,-5 2.9,-5zM9.4,4.5c-0.6,1.1 -1.1,2.6 -1.4,4.5h-3.2c1,-2 2.6,-3.6 4.6,-4.5zM14.6,4.5c2,0.9 3.6,2.5 4.6,4.5h-3.2c-0.3,-1.9 -0.8,-3.4 -1.4,-4.5zM4.2,11h3.6c-0.1,0.7 -0.1,1.3 -0.1,2s0,1.3 0.1,2h-3.6c-0.2,-0.6 -0.2,-1.3 -0.2,-2s0,-1.4 0.2,-2zM9.8,11h4.4c0.1,0.6 0.1,1.3 0.1,2s0,1.4 -0.1,2h-4.4c-0.1,-0.6 -0.1,-1.3 -0.1,-2s0,-1.4 0.1,-2zM16.2,11h3.6c0.1,0.6 0.2,1.3 0.2,2s-0.1,1.4 -0.2,2h-3.6c0.1,-0.7 0.1,-1.3 0.1,-2s0,-1.3 -0.1,-2zM4.8,17h3.2c0.3,1.9 0.8,3.4 1.4,4.5c-2,-0.9 -3.6,-2.5 -4.6,-4.5zM9.1,17h5.8c-0.7,3.4 -2,5 -2.9,5s-2.2,-1.6 -2.9,-5zM16,17h3.2c-1,2 -2.6,3.6 -4.6,4.5c0.6,-1.1 1.1,-2.6 1.4,-4.5z",
    )
    val Paste = icon("Paste", "M9,2h6v2h3a2,2 0 0,1 2,2v14a2,2 0 0,1 -2,2h-12a2,2 0 0,1 -2,-2v-14a2,2 0 0,1 2,-2h3zM9,4v2h6v-2zM6,6v14h12v-14h-1v2h-10v-2z")
    val Video = icon("Video", "M4,5h11a2,2 0 0,1 2,2v2.5l4,-3v11l-4,-3v2.5a2,2 0 0,1 -2,2h-11a2,2 0 0,1 -2,-2v-10a2,2 0 0,1 2,-2z")
    val Music = icon("Music", "M10,3h10v4h-6v10a3.5,3.5 0 1,1 -2,-3.2v-10.8z")
    val Doc = icon("Doc", "M6,2h8l6,6v12a2,2 0 0,1 -2,2h-12a2,2 0 0,1 -2,-2v-16a2,2 0 0,1 2,-2zM13,3.5v5.5h5.5z")
    val Archive = icon("Archive", "M4,3h16v4h-16zM5,8h14v11a2,2 0 0,1 -2,2h-10a2,2 0 0,1 -2,-2zM9,11v2h6v-2z")
    val Image = icon("Image", "M4,4h16a1,1 0 0,1 1,1v14a1,1 0 0,1 -1,1h-16a1,1 0 0,1 -1,-1v-14a1,1 0 0,1 1,-1zM5,18h14l-4.5,-6l-3.5,4.5l-2.5,-3z")
    val File = icon("File", "M6,2h8l6,6v12a2,2 0 0,1 -2,2h-12a2,2 0 0,1 -2,-2v-16a2,2 0 0,1 2,-2z")
}
