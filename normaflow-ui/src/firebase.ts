import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  projectId: "normaflow-bdce3",
  appId: "1:808503554008:web:6dec308d43f07552494cad",
  storageBucket: "normaflow-bdce3.firebasestorage.app",
  apiKey: "AIzaSyBnPYQrrId0yEPw8eHin883ZMzl9gG1rWg",
  authDomain: "normaflow-bdce3.firebaseapp.com",
  messagingSenderId: "808503554008",
  measurementId: "G-26PQTFZNHW"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
