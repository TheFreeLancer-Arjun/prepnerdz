import { Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt from 'jsonwebtoken';
import { JWT_USER_SECRET } from "../config";
import { FINAL_MAIL_VERIFICATION, sendOtp } from "../utils/mail_verification";
import { signinValidationSchema, signupValidationSchema } from "../utils/zodSchema";
import prisma from "../db/prisma";
import { resetPassword, sendOtp_forgotPassword } from "../utils/password_config";

export const signup = async (req: Request, res: Response) => {
    try {

        const result = signupValidationSchema.safeParse(req.body);

        // If validation fails, return an error
        if (!result.success) {
            res.status(400).json({
                message: 'Validation error',
                errors: result.error.flatten().fieldErrors,
            });
            return;
        }

        const { username, email, password } = result.data;

        // Check if user already exists, By email!
        const existingUser = await prisma.user.findUnique({
            where: {
                email: email
            }
        });

        if (existingUser) {
            res.status(400).json({
                message: "User already exists with this Email!!"
            });
            return;
        }

        // checking username uniquenessss
        const existingUserName = await prisma.user.findUnique({
            where: {
                username: username
            }
        });

        if (existingUserName) {
            res.status(400).json({
                message: "Username Already Taken!, Try another one"
            })
            return;
        }

        // Uptill here input validation is done!

        // HASHING THE PASSWORD:

        const hashedPassword = await bcrypt.hash(password, 10);
        const otpGenerated = Math.floor(100000 + Math.random() * 900000).toString();
        // STORING the user to Database!

        const USER = await prisma.user.create({
            data: {
                username: username,
                email: email,
                password: hashedPassword,
                otpForVerification: otpGenerated // THE GENERATED OTP IS STORED IMMEDIATELY IN THE DATABASE!!
            }
        });

        // Otp SENT To the User for Verification
        await sendOtp(email, otpGenerated);

        res.status(201).json({
            message: `OTP Sent to ${USER.email} for verification!`,
            success: true
        })

    } catch (error) {
        console.error(error);
        res.status(500).json({
            message: "Something Went Wrong, Please Try Again Later"
        });
    }
};

export const verify_email = async (req: Request, res: Response) => {
    const { email, otpEntered } = req.body;
    const user = await prisma.user.findUnique({
        where: {
            email
        }
    });

    if (user?.email === email) {
        FINAL_MAIL_VERIFICATION(otpEntered, email, res)
    }
    else {
        res.status(400).json({
            message: "Enter the correct email address, the email which you entered while SignUp!"
        });
        return;
    }
}

export const signin = async (req: Request, res: Response) => {
    try {
        const result = signinValidationSchema.safeParse(req.body);

        // If validation fails, return an error
        if (!result.success) {
            res.status(400).json({
                message: "Validation error",
                errors: result.error.flatten().fieldErrors,
            });
            return;
        }

        const { email, password } = result.data;

        // Find the user in the database
        const user = await prisma.user.findUnique({
            where: { email },
        });

        if (!user) {
            res.status(400).json({
                message: "User Not Found"
            });
            return;
        }

        if (user.isMailVerified === false) {
            res.status(400).json({
                message: "Cannot Login!, Please Verify Your Email First!"
            })
            return;
        }

        // Compare password with hashed password in DB
        const matchPassword = await bcrypt.compare(password, user.password);
        if (!matchPassword) {
            res.status(401).json({
                message: "Incorrect Password!"
            });
            return;
        }

        // Generate JWT token
        const token = jwt.sign(
            {
                id: user.id,
                email: user.email
            },
            JWT_USER_SECRET,
            {
                expiresIn: "4d" // Token expires in 4 day
            }
        );

        // Set the JWT token as an HTTP-only cookie

        res.status(200)
            .cookie("token", token, {
                httpOnly: true,
                secure: process.env.NODE_ENV !== "development", // Secure in production
                sameSite: process.env.NODE_ENV === "development" ? "lax" : "none", // Allow cross-site cookies
                maxAge: 4 * 24 * 60 * 60 * 1000, // 4 days
                path: "/"
            })
            .json({
                success: true,
                message: "User Logged In Successfully!",
                user: {
                    id: user.id,
                    email: user.email
                }
            });

        return;

    } catch (error) {
        console.error("Signin Error:", error);
        res.status(500).json({
            message: "Something Went Wrong, Please Try Again Later"
        });
    }
};

export const logout = (req: Request, res: Response) => {
    try {
        res.clearCookie("token", { httpOnly: true, secure: true, sameSite: "none" });
        res.status(200).json({
            message: "User Logged Out Successfully!"
        });
        return
    } catch (error) {
        console.error("Logout Error:", error);
        res.status(500).json({
            error: "Something went wrong while logging out."
        });
        return
    }
};

export const session = async (req: Request, res: Response) => {
    try {
        // Get token from cookies or Authorization header
        const token = req.cookies?.token || req.headers.authorization?.split(' ')[1] || req.query.token;

        if (!token) {
            res.status(200).json({
                message: {
                    isAuthenticated: false,
                    user: null
                }
            });
            return
        }

        // Verify the token
        const decoded = jwt.verify(token, JWT_USER_SECRET) as { id: string, email: string };

        // Fetch user from database
        const user = await prisma.user.findUnique({
            where: { id: decoded.id },
            select: {
                id: true,
                role: true,
                email: true,
                username: true,
                contactNumber: true,
                isMailVerified: true,
                UserAddedAt: true,
                provider: true
            }
        });

        if (!user) {
            res.status(200).json({
                message: {
                    isAuthenticated: false,
                    user: null
                }
            });
            return
        }

        res.status(200).json({
            message: {
                isAuthenticated: true,
                user: user
            }
        });
        return
    } catch (error) {
        console.error('Session verification error:', error);
        res.status(200).json({
            message: {
                isAuthenticated: false,
                user: null
            }
        });
        return
    }
};

export const me = async (req: Request, res: Response) => {
    try {
        if (!(req as any).user) {
            res.status(401).json({
                message: "ACCESS DENIED"
            })
            return
        }

        const userId = (req as any).user.id;

        const user = await prisma.user.findUnique({
            where: {
                id: userId
            }
        })

        if (!user) {
            res.status(400).json({
                message: "Sorry User Not Found!"
            })
            return
        }

        const finalUserData = {
            username: user?.username,
            email: user?.email,
        }

        res.status(200).json({
            finalUserData
        })

    } catch (error) {
        res.status(500).json({
            message: 'Something Went Wrong, Please Try Again Later',
            error
        });
    }
}

export const forgotPassword = async (req: Request, res: Response) => {

    try {
        const { email } = req.body;

        const user = await prisma.user.findUnique({
            where: {
                email
            }
        })

        if (!user) {
            res.status(400).json({
                message: `User with email ${email} not found in Our Database!, Enter the correct email address, the email which you entered while SignUp!`
            })
            return
        }

        const otpGenerated = Math.floor(100000 + Math.random() * 900000).toString();

        await sendOtp_forgotPassword(email, otpGenerated);

        await prisma.user.update({
            where: {
                email: email
            },
            data: {
                otpForResetPassword: otpGenerated
            }
        })

        res.json({
            message: `OTP Sent to ${user.email} For Password Reset!`,
        })
    } catch (error) {
        console.error(error);
        res.status(500).json({
            message: "Something Went Wrong, Please Try Again Later"
        });
    }
}

export const passwordReset = async (req: Request, res: Response) => {
    const { email, otpEntered, newPassword } = req.body;
    const user = await prisma.user.findUnique({
        where: {
            email
        }
    });

    if (user?.email === email) {
        resetPassword(otpEntered, user?.email as string, newPassword, res);
    }
    else {
        res.status(400).json({
            message: "Enter the correct email address, the email which you entered while SignUp!"
        });
        return;
    }
}


// Dashboard Settings Controllers:

export const updateUsername = async (req: Request, res: Response) => {
    try {
        const { username } = req.body;
        const userId = (req as any).user.id;

        if (!username) {
            res.status(400).json({
                message: "Please Enter a Username"
            })
            return;
        }

        const updatedUser = await prisma.user.update({
            where: {
                id: userId
            },
            data: {
                username: username
            }
        })

        res.status(200).json({
            message: "Username Updated Successfully!",
            success: true,
            data: updatedUser
        })

    } catch (error) {
        console.error(error);
        res.status(500).json({
            message: "Something Went Wrong, Please Try Again Later"
        });
    }
}

export const updateContact = async (req: Request, res: Response) => {
    try {
        const { contact } = req.body;

        if (!contact) {
            res.status(400).json({
                message: "Please Enter a Contact Number"
            })
            return;
        }

        const userId = (req as any).user.id;

        const updatedUser = await prisma.user.update({
            where: {
                id: userId
            },
            data: {
                contactNumber: contact
            }
        })

        res.status(200).json({
            message: "Contact Number Updated Successfully!",
            success: true,
            data: updatedUser
        })

    } catch (error) {
        console.error(error);
        res.status(500).json({
            message: "Something Went Wrong, Please Try Again Later"
        });
        return;
    }
}

export const directOtpVerification = async (req: Request, res: Response) => {
    try {
        const { email, contact } = req.body;

        if (!contact || !email) {
            res.status(400).json({
                message: "Please Enter a Contact Number"
            })
            return;
        }
        const user = await prisma.user.findUnique({
            where: {
                email
            }
        });

        if (!user) {
            res.status(400).json({
                message: "User Not Found, please enter valid email address!"
            })
            return;
        }

        const verifyAccount = await prisma.user.update({
            where: {
                email: email
            },
            data: {
                isMailVerified: true,
                contactNumber: contact,
                otpForVerification: "MAIL_VERIFICATION_DONE",
                provider: "phone"
            }
        })

        res.status(200).json({
            message: "Account Verification Successfully!",
            success: true,
            data: verifyAccount
        })

    } catch (error) {
        console.error(error);
        res.status(500).json({
            message: "Something Went Wrong, Please Try Again Later"
        });
        return;
    }
}