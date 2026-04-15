# Laya Service Portal (MoringCard-ready)

เวอร์ชันนี้ถูกปรับให้หน้า Service อ่านข้อมูลจาก Firebase โปรเจกต์เดียวกับ Checkin คือ **moringcard** โดยตรง
และค้นหาห้องจาก collection `guest_daily` ทันที

## ต้องแก้ก่อนใช้งาน
เปิดไฟล์ `frontend/shared/firebase-config.js` แล้วใส่ค่า Web Config ของโปรเจกต์ moringcard ให้ครบ

## หลังจากใส่ config แล้ว
1. เปิด Anonymous Auth ในโปรเจกต์ moringcard
2. ตั้ง Firestore Rules ให้อ่าน `guest_daily` ได้สำหรับ user ที่ sign in แล้ว
3. อัปไฟล์ทั้งหมดขึ้น GitHub Pages

## Collection ที่หน้าเว็บจะใช้
- อ่าน: `guest_daily`
- บันทึก session/login log: `guest_portal_sessions`

## หมายเหตุ
ถ้าไม่ใส่ Web Config ของ moringcard หน้าเว็บจะยังเชื่อม Firebase ไม่ได้
