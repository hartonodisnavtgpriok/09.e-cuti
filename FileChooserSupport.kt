// ===== 1) AndroidManifest.xml =====
// Di dalam <manifest> (di luar <application>):
//   <uses-permission android:name="android.permission.CAMERA" />
//   <uses-feature android:name="android.hardware.camera" android:required="false" />
// Di dalam <application>:
//   <provider
//       android:name="androidx.core.content.FileProvider"
//       android:authorities="${applicationId}.fileprovider"
//       android:exported="false"
//       android:grantUriPermissions="true">
//       <meta-data android:name="android.support.FILE_PROVIDER_PATHS"
//                  android:resource="@xml/file_paths" />
//   </provider>
//
// ===== 2) res/xml/file_paths.xml (buat file baru) =====
//   <?xml version="1.0" encoding="utf-8"?>
//   <paths>
//       <cache-path name="photos" path="." />
//   </paths>
//
// ===== 3) MainActivity.kt: tambahkan import dan isi berikut =====

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.MediaStore
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import java.io.File

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var cameraUri: Uri? = null

    private val cameraPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* hasil tidak perlu ditangani */ }

    private val chooserLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            var uris: Array<Uri>? = null
            if (result.resultCode == Activity.RESULT_OK) {
                val data = result.data
                val clip = data?.clipData
                uris = when {
                    clip != null -> Array(clip.itemCount) { clip.getItemAt(it).uri }
                    data?.data != null -> arrayOf(data.data!!)
                    cameraUri != null -> arrayOf(cameraUri!!)
                    else -> null
                }
            }
            filePathCallback?.onReceiveValue(uris)
            filePathCallback = null
            cameraUri = null
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // ... kode Anda yang sudah ada (setContentView, webView = findViewById(...), loadUrl, dst.)

        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.allowFileAccess = true

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            cameraPermission.launch(Manifest.permission.CAMERA)
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback

                // Intent kamera (foto langsung disimpan ke cache, lalu dikirim ke halaman)
                var cameraIntent: Intent? = null
                if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.CAMERA)
                    == PackageManager.PERMISSION_GRANTED) {
                    val photo = File.createTempFile("foto_", ".jpg", cacheDir)
                    cameraUri = FileProvider.getUriForFile(this@MainActivity, "$packageName.fileprovider", photo)
                    cameraIntent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
                        putExtra(MediaStore.EXTRA_OUTPUT, cameraUri)
                        addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                    }
                }

                val intent: Intent = if (params.isCaptureEnabled && cameraIntent != null) {
                    cameraIntent                     // tombol "Ambil Foto": langsung buka kamera
                } else {
                    val picker = params.createIntent() // tombol "Unggah Berkas": pemilih berkas
                    Intent.createChooser(picker, "Pilih berkas").apply {
                        if (cameraIntent != null) putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(cameraIntent))
                    }
                }

                return try {
                    chooserLauncher.launch(intent)
                    true
                } catch (e: Exception) {
                    filePathCallback?.onReceiveValue(null)
                    filePathCallback = null
                    false
                }
            }
        }
    }
}
