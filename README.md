# LAYA Hotel Portal (IHN / Check-in Sync)

หน้าแรกของระบบให้แขกกรอกเลขห้องเพียงอย่างเดียว จากนั้นระบบจะอ่านข้อมูลจาก Firestore collection `guest_daily` ของระบบ Check-in / IHN แล้วพาไปหน้ารวมแผนก

## สิ่งที่ต้องตั้งค่าก่อนใช้งานจริง

1. ใส่ Firebase config เดียวกับระบบ Check-in ในไฟล์ `frontend/shared/firebase-config.js`
2. เปิด Anonymous Auth ใน Firebase Authentication
3. ให้ Firestore rules อนุญาตให้อ่าน collection `guest_daily` ได้สำหรับ anonymous user หรือ user ที่โรงแรมกำหนด

## Flow

- Guest เปิดหน้าแรก
- กรอกเลขห้อง เช่น `A203`
- ระบบเช็ก format ห้อง
- ระบบ sign in แบบ anonymous
- ระบบค้นหาใน `guest_daily`
- ถ้าพบข้อมูล จะดึงชื่อผู้เข้าพัก / package / pax มาเก็บเป็น session ฝั่ง browser
- จากนั้น redirect ไปหน้า `departments/index.html`
