package com.namao.delivery;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ContentResolver;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private static final String ORDER_CHANNEL_ID = "namao_orders_v2";
    private static final String MESSAGE_CHANNEL_ID = "namao_messages_v2";
    private static final String PAYOUT_CHANNEL_ID = "namao_payouts";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        createNotificationChannels();
    }

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;

        AudioAttributes attrs = new AudioAttributes.Builder()
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .build();

        // Canal para novos pedidos: importância MAX, som custom alto, vibração agressiva
        if (nm.getNotificationChannel(ORDER_CHANNEL_ID) == null) {
            NotificationChannel orderChan = new NotificationChannel(
                    ORDER_CHANNEL_ID,
                    "Novos pedidos",
                    NotificationManager.IMPORTANCE_HIGH
            );
            orderChan.setDescription("Toca alto quando um pedido novo aparece");
            Uri orderSoundUri = Uri.parse(
                    ContentResolver.SCHEME_ANDROID_RESOURCE + "://" + getPackageName() + "/raw/new_order"
            );
            orderChan.setSound(orderSoundUri, attrs);
            orderChan.enableVibration(true);
            orderChan.setVibrationPattern(new long[]{0, 600, 300, 600, 300, 600});
            orderChan.enableLights(true);
            orderChan.setShowBadge(true);
            orderChan.setBypassDnd(true);
            orderChan.setLockscreenVisibility(NotificationManager.IMPORTANCE_HIGH);
            nm.createNotificationChannel(orderChan);
        }

        // Canal para mensagens do cliente
        if (nm.getNotificationChannel(MESSAGE_CHANNEL_ID) == null) {
            NotificationChannel msgChan = new NotificationChannel(
                    MESSAGE_CHANNEL_ID,
                    "Mensagens do cliente",
                    NotificationManager.IMPORTANCE_HIGH
            );
            msgChan.setDescription("Som curto pra mensagens no chat do pedido");
            Uri msgSoundUri = Uri.parse(
                    ContentResolver.SCHEME_ANDROID_RESOURCE + "://" + getPackageName() + "/raw/new_message"
            );
            msgChan.setSound(msgSoundUri, attrs);
            msgChan.enableVibration(true);
            msgChan.setVibrationPattern(new long[]{0, 100, 50, 100});
            msgChan.setShowBadge(true);
            nm.createNotificationChannel(msgChan);
        }

        // Canal para atualizações de saque/repasse PIX (pagamento confirmado pelo admin)
        if (nm.getNotificationChannel(PAYOUT_CHANNEL_ID) == null) {
            NotificationChannel payChan = new NotificationChannel(
                    PAYOUT_CHANNEL_ID,
                    "Saques PIX",
                    NotificationManager.IMPORTANCE_HIGH
            );
            payChan.setDescription("Avisa quando seu saque foi enviado ou cancelado");
            Uri paySoundUri = Uri.parse(
                    ContentResolver.SCHEME_ANDROID_RESOURCE + "://" + getPackageName() + "/raw/new_message"
            );
            payChan.setSound(paySoundUri, attrs);
            payChan.enableVibration(true);
            payChan.setVibrationPattern(new long[]{0, 200, 100, 200});
            payChan.setShowBadge(true);
            nm.createNotificationChannel(payChan);
        }
    }
}
