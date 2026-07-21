import React from 'react';
import './App.css';

const FeedbackForm = () => {
    return (
        <div className="container">
            <h1>We Value Your Feedback!</h1>
            <form>
                <label htmlFor="email">Email:</label>
                <input type="email" id="email" name="email" required placeholder="Enter your email" />
                <label>Rate Us:</label>
                <div className="rating">
                    {[1, 2, 3, 4, 5].map((i) => (
                        <label key={i}>
                            <input type="radio" name="rating" value={i} /> {i}
                        </label>
                    ))}
                </div>
                <label htmlFor="comments">Comments:</label>
                <textarea id="comments" name="comments" rows="4" placeholder="Share your thoughts..."></textarea>
                <button type="submit">Submit Feedback</button>
            </form>
        </div>
    );
};

export default FeedbackForm;